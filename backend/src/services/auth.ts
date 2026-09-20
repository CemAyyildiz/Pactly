/**
 * Composes this story's two authentication jobs -- verifying a Pactly JWT,
 * and separately, getting or refreshing a wallet's cached anchor JWT -- the
 * one place a later story's route calls into (routes -> services ->
 * db/chain/anchor/auth, one-way). Nothing outside `db/` builds SQL here;
 * nothing outside `anchor/` talks to the anchor.
 *
 * Re-exports `verifyPactlyJwt` rather than wrapping it: verifying Pactly's
 * own JWT needs no database round trip (it is self-contained by design --
 * see `auth/challenge.ts`'s own comment), so there is nothing for this
 * module to compose on that side beyond naming it as part of the same
 * surface `getOrRefreshAnchorJwt` lives on.
 */
import type { Keypair } from "@stellar/stellar-sdk";

import { verifyPactlyJwt, type PactlyJwtOptions, type VerifiedPactlyJwt } from "../auth/challenge.js";
import { config } from "../config.js";
import { discoverAnchorSepEndpoints, type FetchLike } from "../anchor/stellar-toml.js";
import {
  fetchAnchorSep10Challenge,
  runAnchorSep10,
  submitAnchorSep10Challenge,
  type Sep10FetchLike,
} from "../anchor/sep10.js";
import { AnchorAuthRequiredError, AnchorSignerMismatchError } from "../anchor/errors.js";
import { getAnchorJwt, upsertAnchorJwt } from "../db/anchorJwts.js";
import type { Db } from "../db/client.js";

export { verifyPactlyJwt, type PactlyJwtOptions, type VerifiedPactlyJwt };

/** A cached anchor JWT within this margin of its real expiry is treated as
 * stale and refreshed early, rather than handed out and then rejected by
 * the anchor mid-request (a token with only milliseconds left is
 * technically "still valid" but practically useless to a caller). */
const CACHE_FRESHNESS_MARGIN_MS = 30_000;

export interface GetOrRefreshAnchorJwtDeps {
  /** Injectable clock -- defaults to the real one. Lets a test assert the
   * "still valid, reused" and "expired, refetched" rows of the I/O matrix
   * without a real wall-clock wait. */
  now?: () => number;
  /** Overrides `stellar.toml`'s fetch -- defaults to the real network call. */
  tomlFetch?: FetchLike;
  /** Overrides the anchor's SEP-10 request/submit calls -- defaults to the
   * real network call. */
  sep10Fetch?: Sep10FetchLike;
}

/**
 * Returns a wallet's anchor JWT, reusing a still-valid cached one (no new
 * anchor round trip) or running the anchor's real SEP-10 exchange and
 * caching the result when there is none, or the cached one has expired.
 * `signer` must be the keypair for `walletAddress` -- the anchor's
 * `require_auth`-equivalent (its SEP-10 endpoint) needs the wallet's own
 * signature, not merely its address.
 */
export async function getOrRefreshAnchorJwt(
  db: Db,
  walletAddress: string,
  signer: Keypair,
  deps: GetOrRefreshAnchorJwtDeps = {},
): Promise<string> {
  if (signer.publicKey() !== walletAddress) {
    throw new AnchorSignerMismatchError(
      `signer (${signer.publicKey()}) does not match walletAddress (${walletAddress}); the anchor's SEP-10 exchange requires the named wallet's own signature.`,
    );
  }
  const now = deps.now ?? (() => Date.now());
  const cached = await getAnchorJwt(db, walletAddress);
  if (cached && cached.expiresAt > now() + CACHE_FRESHNESS_MARGIN_MS) {
    return cached.jwt;
  }

  const endpoints = await discoverAnchorSepEndpoints(config.anchorHomeDomain, deps.tomlFetch);
  const { token, expiresAt } = await runAnchorSep10(
    {
      webAuthEndpoint: endpoints.webAuthEndpoint,
      signingKey: endpoints.signingKey,
      homeDomain: config.anchorHomeDomain,
      networkPassphrase: config.stellarNetworkPassphrase,
      account: walletAddress,
      signer,
    },
    deps.sep10Fetch,
  );
  await upsertAnchorJwt(db, { walletAddress, jwt: token, expiresAt, updatedAt: now() });
  return token;
}

/** Returns a still-fresh cached anchor JWT, or `undefined` when none
 * exists / it is inside the freshness margin of expiry. Never hits the
 * network -- Story 2.4's "Reuse" row. */
export async function getFreshAnchorJwt(
  db: Db,
  walletAddress: string,
  deps: Pick<GetOrRefreshAnchorJwtDeps, "now"> = {},
): Promise<string | undefined> {
  const now = deps.now ?? (() => Date.now());
  const cached = await getAnchorJwt(db, walletAddress);
  if (cached && cached.expiresAt > now() + CACHE_FRESHNESS_MARGIN_MS) {
    return cached.jwt;
  }
  return undefined;
}

/** Throws {@link AnchorAuthRequiredError} when the wallet has no still-valid
 * cached anchor JWT -- the deposit/poll/simulate path never silently
 * starts a new challenge (the client must sign that). */
export async function requireFreshAnchorJwt(
  db: Db,
  walletAddress: string,
  deps: Pick<GetOrRefreshAnchorJwtDeps, "now"> = {},
): Promise<string> {
  const token = await getFreshAnchorJwt(db, walletAddress, deps);
  if (!token) {
    throw new AnchorAuthRequiredError();
  }
  return token;
}

export interface BeginAnchorSep10Result {
  /** `true` when a still-valid cached JWT exists -- no challenge to sign. */
  authenticated: boolean;
  unsignedXdr?: string;
}

/** Story 2.4: either reuses a fresh cached JWT or returns the unsigned
 * challenge XDR for the client to sign in their wallet. */
export async function beginAnchorSep10(
  db: Db,
  walletAddress: string,
  deps: GetOrRefreshAnchorJwtDeps = {},
): Promise<BeginAnchorSep10Result> {
  if (await getFreshAnchorJwt(db, walletAddress, deps)) {
    return { authenticated: true };
  }
  const endpoints = await discoverAnchorSepEndpoints(config.anchorHomeDomain, deps.tomlFetch);
  const { unsignedXdr } = await fetchAnchorSep10Challenge(
    {
      webAuthEndpoint: endpoints.webAuthEndpoint,
      signingKey: endpoints.signingKey,
      homeDomain: config.anchorHomeDomain,
      networkPassphrase: config.stellarNetworkPassphrase,
      account: walletAddress,
    },
    deps.sep10Fetch,
  );
  return { authenticated: false, unsignedXdr };
}

/** Story 2.4: submits the client-signed challenge, stores the JWT, never
 * returns the token to the caller (AD-5). */
export async function completeAnchorSep10(
  db: Db,
  walletAddress: string,
  signedXdr: string,
  deps: GetOrRefreshAnchorJwtDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const endpoints = await discoverAnchorSepEndpoints(config.anchorHomeDomain, deps.tomlFetch);
  const { token, expiresAt } = await submitAnchorSep10Challenge(
    {
      webAuthEndpoint: endpoints.webAuthEndpoint,
      signingKey: endpoints.signingKey,
      homeDomain: config.anchorHomeDomain,
      networkPassphrase: config.stellarNetworkPassphrase,
      account: walletAddress,
      signedXdr,
    },
    deps.sep10Fetch,
  );
  await upsertAnchorJwt(db, { walletAddress, jwt: token, expiresAt, updatedAt: now() });
}
