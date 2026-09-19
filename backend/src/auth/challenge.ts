/**
 * Pactly's own SEP-10-shaped login (AD-5, FR10): a challenge transaction
 * this backend builds, signs and verifies itself under `PACTLY_HOME_DOMAIN`
 * -- never the anchor's challenge, never the anchor's domain (see
 * `../anchor/sep10.ts` for that side). This is the platform's whole login
 * mechanism: no passwords, ever.
 *
 * Challenge construction and verification go through @stellar/stellar-sdk's
 * own `WebAuth.buildChallengeTx` / `WebAuth.readChallengeTx` /
 * `WebAuth.verifyChallengeTxSigners` -- the SEP-10 toolkit this SDK ships
 * for *implementing* a server, not only consuming one (design note: "one
 * audited code path proves wallet ownership everywhere in this codebase").
 * The story spec names these `Utils.*`; in the pinned 17.1.0 release the
 * same functions live on the `WebAuth` namespace instead (confirmed against
 * the installed package) -- this module calls the real export, not the
 * literal name, since the constraint is "never hand-rolled," not a specific
 * spelling.
 *
 * The Pactly JWT is issued and verified with `jose` (never raw HMAC code),
 * carrying the wallet address as `sub` and an expiry as `exp` -- both
 * checked against an injectable clock so an "expired" test never has to
 * sleep for real minutes.
 */
import { createHash } from "node:crypto";
import { Keypair, StrKey, WebAuth, type Transaction } from "@stellar/stellar-sdk";
import { SignJWT, jwtVerify } from "jose";

import { config } from "../config.js";
import { redeemChallengeNonceIfUnused } from "../db/challengeNonces.js";
import type { Db } from "../db/client.js";
import {
  PactlyChallengeExpiredError,
  PactlyChallengeInvalidError,
  PactlyChallengeReplayedError,
  PactlyInvalidAccountError,
  PactlyJwtError,
} from "./errors.js";

/** SEP-10's own default validity window; `readChallengeTx`/
 * `verifyChallengeTxSigners` additionally allow a 5-minute grace period on
 * top of this (baked into the SDK, not configurable here). */
const CHALLENGE_TIMEOUT_SECONDS = 300;

/** How long a Pactly JWT is valid for once issued. */
const JWT_TTL_SECONDS = 3600;

/** Derived once per process from `PACTLY_AUTH_SIGNING_SECRET`, prefixed so
 * this never collides with the same secret's other use as the JWT's HMAC
 * key -- the Stellar identity Pactly's own challenge is issued and verified
 * under. Deterministic across restarts (a challenge issued just before a
 * restart still verifies after it), never sent anywhere, never the
 * anchor's own key. Memoized the same way `chain/client.ts` memoizes its
 * RPC server: computed at most once, and only when something actually
 * calls into this module. */
let cachedServerKeypair: Keypair | undefined;
function serverKeypair(): Keypair {
  if (!cachedServerKeypair) {
    const seed = createHash("sha256").update(`pactly-sep10-server-key:${config.pactlyAuthSigningSecret}`).digest();
    cachedServerKeypair = Keypair.fromRawEd25519Seed(seed);
  }
  return cachedServerKeypair;
}

function jwtSecret(): Uint8Array {
  return new TextEncoder().encode(config.pactlyAuthSigningSecret);
}

function requireValidAccountId(publicKey: string): void {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new PactlyInvalidAccountError(`"${publicKey}" is not a valid Stellar account id.`);
  }
}

/**
 * Builds a challenge transaction naming `walletPublicKey` under
 * `PACTLY_HOME_DOMAIN`, signed by this backend's own server key. Returns
 * the base64 XDR envelope a caller hands to the wallet to countersign.
 */
export function buildPactlyChallenge(walletPublicKey: string): string {
  requireValidAccountId(walletPublicKey);
  return WebAuth.buildChallengeTx(
    serverKeypair(),
    walletPublicKey,
    config.pactlyHomeDomain,
    CHALLENGE_TIMEOUT_SECONDS,
    config.stellarNetworkPassphrase,
    config.pactlyHomeDomain,
  );
}

export interface VerifiedChallenge {
  walletAddress: string;
}

/** Translates the SDK's own `InvalidChallengeError` into one of this
 * module's typed errors -- expiry named explicitly, everything else (wrong
 * signer, missing signer, malformed transaction) collapsed into the one
 * "invalid" shape the I/O matrix requires. Anything that is not an
 * `InvalidChallengeError` at all (a programming error, not a rejected
 * challenge) is rethrown unchanged. */
function translateChallengeError(cause: unknown): Error {
  if (cause instanceof WebAuth.InvalidChallengeError) {
    if (/expired/i.test(cause.message)) {
      return new PactlyChallengeExpiredError(`The challenge has expired: ${cause.message}`);
    }
    return new PactlyChallengeInvalidError();
  }
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** The challenge's own single-use nonce: the (already length- and
 * shape-validated, by `readChallengeTx`) `manage_data` operation's raw
 * value, taken as an opaque byte string. Random per challenge
 * (`buildChallengeTx` fills it with 48 random bytes), so it is exactly the
 * thing to key replay detection on -- unlike the transaction's XDR, it does
 * not change if a wallet re-serializes/re-encodes the same signed envelope. */
function challengeNonce(tx: Transaction): string {
  const [operation] = tx.operations;
  const value = operation && operation.type === "manageData" ? operation.value : undefined;
  if (!value) {
    // Unreachable in practice: readChallengeTx already required exactly
    // this shape before returning `tx`. Guarded anyway rather than assumed.
    throw new PactlyChallengeInvalidError();
  }
  return Buffer.from(value).toString("base64");
}

/**
 * Verifies a challenge transaction signed and returned by a wallet: it must
 * be the one this backend issued (server-signed, correct home domain,
 * unexpired), must carry a signature from the exact wallet the challenge
 * named when it was built -- a signature from a *different* key is rejected
 * exactly as no signature would be (I/O matrix) -- and must not have been
 * verified successfully before: a signed envelope is single-use, recorded
 * as redeemed in `used_challenge_nonces` at the moment it first succeeds,
 * so replaying the same signed envelope for a second Pactly JWT is refused
 * (confirmed exploitable before this check existed -- the same signed
 * request POSTed twice both returned 200 with a fresh token). The wallet is
 * read from the challenge itself (the `manage_data` operation's source,
 * fixed at build time by {@link buildPactlyChallenge}), never supplied
 * separately by the caller -- there is nothing for a caller to lie about.
 */
export async function verifyPactlyChallenge(db: Db, signedChallengeXdr: string): Promise<VerifiedChallenge> {
  const server = serverKeypair();
  let clientAccountID: string;
  let tx: Transaction;
  try {
    ({ clientAccountID, tx } = WebAuth.readChallengeTx(
      signedChallengeXdr,
      server.publicKey(),
      config.stellarNetworkPassphrase,
      config.pactlyHomeDomain,
      config.pactlyHomeDomain,
    ));
  } catch (cause) {
    throw translateChallengeError(cause);
  }
  try {
    WebAuth.verifyChallengeTxSigners(
      signedChallengeXdr,
      server.publicKey(),
      config.stellarNetworkPassphrase,
      [clientAccountID],
      config.pactlyHomeDomain,
      config.pactlyHomeDomain,
    );
  } catch (cause) {
    throw translateChallengeError(cause);
  }

  const nonce = challengeNonce(tx);
  // The challenge's own expiry (its timebounds' maxTime), so a future
  // cleanup pass has a basis to prune this row -- not required for
  // correctness (a nonce is never valid to reuse, ever), only for hygiene.
  const expiresAt = tx.timeBounds ? Number(tx.timeBounds.maxTime) * 1000 : Date.now();
  const firstUse = await redeemChallengeNonceIfUnused(db, nonce, expiresAt);
  if (!firstUse) {
    throw new PactlyChallengeReplayedError();
  }

  return { walletAddress: clientAccountID };
}

export interface PactlyJwtOptions {
  /** Injectable clock -- defaults to the real one. A test fixes this to
   * assert the expiry behavior without a real wall-clock wait. */
  now?: () => Date;
}

/** Issues a Pactly JWT for `walletAddress`, valid for {@link JWT_TTL_SECONDS}
 * from `options.now()`. */
export async function issuePactlyJwt(walletAddress: string, options: PactlyJwtOptions = {}): Promise<string> {
  const now = (options.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + JWT_TTL_SECONDS * 1000);
  return new SignJWT({ sub: walletAddress })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(jwtSecret());
}

export interface VerifiedPactlyJwt {
  walletAddress: string;
}

/** Verifies a Pactly JWT and returns the wallet address it names. Missing,
 * expired and tampered tokens all fail through the same
 * {@link PactlyJwtError} shape -- see that class's own comment for why. */
export async function verifyPactlyJwt(token: string, options: PactlyJwtOptions = {}): Promise<VerifiedPactlyJwt> {
  if (!token) {
    throw new PactlyJwtError();
  }
  const now = (options.now ?? (() => new Date()))();
  try {
    const { payload } = await jwtVerify(token, jwtSecret(), { algorithms: ["HS256"], currentDate: now });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new PactlyJwtError();
    }
    return { walletAddress: payload.sub };
  } catch {
    throw new PactlyJwtError();
  }
}
