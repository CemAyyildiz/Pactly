/**
 * The anchor's real SEP-10 client: requests a challenge from the discovered
 * `WEB_AUTH_ENDPOINT`, confirms it actually came from the anchor (signed by
 * the `SIGNING_KEY` `stellar-toml.ts` discovered, via the SDK's own
 * `WebAuth.readChallengeTx` -- never hand-rolled), signs it with the
 * caller-supplied signer, submits it, and returns the anchor's JWT and its
 * expiry.
 *
 * Mirrors `chain/client.ts`'s shape: every network stage sits behind one
 * injectable `fetch`-shaped seam that defaults to the real implementation,
 * so a caller that overrides it never reaches `tr-mock-anchor.fly.dev`, and
 * a caller that does not override it gets the real network.
 */
import { Keypair, TransactionBuilder, WebAuth, type Transaction } from "@stellar/stellar-sdk";

import { AnchorAuthError } from "./errors.js";

const REQUEST_TIMEOUT_MS = 10_000;

/** Minimal shape this module needs from `fetch` -- request in, response out
 * -- so a test can stub both the GET (challenge) and POST (submit) legs of
 * the exchange without touching the network. */
export type Sep10FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

function defaultFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Pick<Response, "ok" | "status" | "json" | "text">> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export interface AnchorSep10ChallengeParams {
  webAuthEndpoint: string;
  /** From `stellar.toml`'s `SIGNING_KEY` -- the anchor's own account, used
   * to confirm the challenge really came from the anchor. */
  signingKey: string;
  homeDomain: string;
  networkPassphrase: string;
  /** The wallet the JWT should be issued for. */
  account: string;
}

export interface RunAnchorSep10Params extends AnchorSep10ChallengeParams {
  /** Signs the anchor's challenge. Must be `account`'s own keypair -- the
   * managed-account path (`services/auth.ts`'s `getOrRefreshAnchorJwt`) is
   * the only caller that holds a key. Story 2.4's wallet path uses
   * {@link fetchAnchorSep10Challenge} + {@link submitAnchorSep10Challenge}
   * so the client signs in their own wallet instead. */
  signer: Keypair;
}

export interface AnchorSep10Result {
  token: string;
  /** Epoch milliseconds, decoded from the JWT's own `exp` claim -- the
   * anchor's JWT is opaque to this backend otherwise; this is the one claim
   * `services/auth.ts`'s cache needs to know when to refresh. */
  expiresAt: number;
}

interface ChallengeResponseBody {
  transaction?: unknown;
  network_passphrase?: unknown;
}

interface TokenResponseBody {
  token?: unknown;
  error?: unknown;
}

/** Reads a JSON body off a fetch-like response, translating a body that is
 * not valid JSON into an {@link AnchorAuthError} naming the domain rather
 * than letting a raw parse error escape. */
async function readJson(response: Pick<Response, "json" | "text">, homeDomain: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorAuthError(`${homeDomain} returned a response that was not valid JSON: ${reason}`);
  }
}

/** Pulls the anchor's own explanation out of an already-parsed error
 * response body, if it supplied one -- the I/O matrix's "surfacing the
 * anchor's own reason". */
function anchorReason(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim() !== "") return error.trim();
  }
  return undefined;
}

/** Reads a non-OK response's body exactly once (via `.text()`, never
 * `.json()` -- a real `Response`'s body can only be consumed once, so this
 * must not try `.json()` first and fall back to `.text()` on the same
 * response) and extracts a reason to surface: the anchor's own `error`
 * field when the body happens to be JSON, otherwise the raw text (a 502
 * page, an empty body) -- never an opaque "not valid JSON" failure hiding
 * the anchor's real status and reason. */
async function anchorReasonFromResponse(response: Pick<Response, "text">): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (text.trim() === "") return undefined;
  try {
    return anchorReason(JSON.parse(text)) ?? text.trim();
  } catch {
    return text.trim();
  }
}

/** Decodes (never verifies -- this backend has no way to, and does not need
 * to: the JWT arrived over the anchor's own HTTPS endpoint) a compact JWT's
 * payload segment and reads its `exp` claim (seconds since epoch). Throws
 * {@link AnchorAuthError} if the token is not a 3-part compact JWT or carries
 * no usable `exp`, since the cache this feeds cannot safely treat a token
 * of unknown expiry as fresh. */
function decodeJwtExpiryMs(token: string, homeDomain: string): number {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AnchorAuthError(`${homeDomain} returned a token that is not a JWT`);
  }
  let payload: unknown;
  try {
    const json = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorAuthError(`${homeDomain} returned a token whose payload could not be decoded: ${reason}`);
  }
  const exp = typeof payload === "object" && payload !== null ? (payload as { exp?: unknown }).exp : undefined;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new AnchorAuthError(`${homeDomain} returned a token with no usable "exp" claim`);
  }
  const expiresAt = exp * 1000;
  // A token already expired (or expiring this same millisecond) the moment
  // it arrives cannot safely seed the cache: it would look either
  // permanently stale (never reused) or, worse, be misread as fresh by a
  // caller that mishandles the boundary. Refuse it outright instead.
  if (expiresAt <= Date.now()) {
    throw new AnchorAuthError(`${homeDomain} returned a token that is already expired (exp ${new Date(expiresAt).toISOString()})`);
  }
  return expiresAt;
}

export interface FetchAnchorSep10ChallengeResult {
  /** Unsigned challenge XDR -- Story 2.4's wallet path sends this to the
   * client to sign; Pactly never holds the key. */
  unsignedXdr: string;
}

/** Story 2.4: fetches and validates the anchor's SEP-10 challenge without
 * signing it, so the client's own wallet can. The managed-account path
 * still signs server-side via {@link runAnchorSep10}. */
export async function fetchAnchorSep10Challenge(
  params: AnchorSep10ChallengeParams,
  fetchImpl: Sep10FetchLike = defaultFetch,
): Promise<FetchAnchorSep10ChallengeResult> {
  const { webAuthEndpoint, signingKey, homeDomain, networkPassphrase, account } = params;

  const challengeUrl = new URL(webAuthEndpoint);
  challengeUrl.searchParams.set("account", account);

  let challengeResponse: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    challengeResponse = await fetchImpl(challengeUrl.toString(), { method: "GET" });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorAuthError(`Could not reach ${homeDomain}'s SEP-10 endpoint: ${reason}`);
  }
  // Check the status before ever parsing the body as JSON: an error page
  // (a 502, an empty body) is not JSON, and the anchor's real status and
  // reason -- what the I/O matrix asks to be surfaced -- must win over an
  // opaque "not valid JSON" failure.
  if (!challengeResponse.ok) {
    const reason = await anchorReasonFromResponse(challengeResponse);
    throw new AnchorAuthError(
      `${homeDomain} refused the SEP-10 challenge request (HTTP ${challengeResponse.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  const challengeBody = (await readJson(challengeResponse, homeDomain)) as ChallengeResponseBody;
  if (typeof challengeBody.transaction !== "string" || challengeBody.transaction.trim() === "") {
    throw new AnchorAuthError(`${homeDomain}'s SEP-10 challenge response did not include a transaction`);
  }
  if (typeof challengeBody.network_passphrase === "string" && challengeBody.network_passphrase !== networkPassphrase) {
    throw new AnchorAuthError(
      `${homeDomain}'s SEP-10 challenge declared network_passphrase "${challengeBody.network_passphrase}", ` +
        `expected "${networkPassphrase}"`,
    );
  }
  const challengeXdr = challengeBody.transaction;

  // Confirm this really is a challenge from the anchor -- signed by its own
  // `SIGNING_KEY`, naming its own home domain -- and that it names the
  // wallet this exchange is for. Uses the SDK's own reader, never a
  // hand-rolled check.
  let clientAccountID: string;
  try {
    ({ clientAccountID } = WebAuth.readChallengeTx(challengeXdr, signingKey, networkPassphrase, homeDomain, challengeUrl.host));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorAuthError(`${homeDomain}'s SEP-10 challenge did not pass validation: ${reason}`);
  }
  if (clientAccountID !== account) {
    throw new AnchorAuthError(
      `${homeDomain}'s SEP-10 challenge names account "${clientAccountID}", but this exchange is for "${account}"`,
    );
  }

  return { unsignedXdr: challengeXdr };
}

export interface SubmitAnchorSep10ChallengeParams extends AnchorSep10ChallengeParams {
  signedXdr: string;
}

/** Submits a client-signed SEP-10 challenge and returns the anchor's JWT.
 * Re-validates that the signed envelope is still a challenge for `account`
 * before posting it, so a signed challenge for a different wallet cannot
 * mint a JWT stored under this one. */
export async function submitAnchorSep10Challenge(
  params: SubmitAnchorSep10ChallengeParams,
  fetchImpl: Sep10FetchLike = defaultFetch,
): Promise<AnchorSep10Result> {
  const { webAuthEndpoint, signingKey, homeDomain, networkPassphrase, account, signedXdr } = params;
  const challengeHost = new URL(webAuthEndpoint).host;

  let clientAccountID: string;
  try {
    ({ clientAccountID } = WebAuth.readChallengeTx(signedXdr, signingKey, networkPassphrase, homeDomain, challengeHost));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorAuthError(`${homeDomain}'s signed SEP-10 challenge did not pass validation: ${reason}`);
  }
  if (clientAccountID !== account) {
    throw new AnchorAuthError(
      `${homeDomain}'s signed SEP-10 challenge names account "${clientAccountID}", but this exchange is for "${account}"`,
    );
  }

  let tokenResponse: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    tokenResponse = await fetchImpl(webAuthEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: signedXdr }),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorAuthError(`Could not reach ${homeDomain}'s SEP-10 endpoint: ${reason}`);
  }
  if (!tokenResponse.ok) {
    const reason = await anchorReasonFromResponse(tokenResponse);
    throw new AnchorAuthError(
      `${homeDomain} rejected the signed SEP-10 challenge (HTTP ${tokenResponse.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  const tokenBody = (await readJson(tokenResponse, homeDomain)) as TokenResponseBody;
  if (typeof tokenBody.token !== "string" || tokenBody.token.trim() === "") {
    throw new AnchorAuthError(`${homeDomain}'s SEP-10 response did not include a token`);
  }

  return { token: tokenBody.token, expiresAt: decodeJwtExpiryMs(tokenBody.token, homeDomain) };
}

/** Runs the anchor's real SEP-10 exchange end to end and returns its JWT.
 * Nothing is stored here -- storing the result, keyed by wallet address, is
 * `../services/auth.ts`'s job, so this module stays a pure network client.
 * Signs with the caller-supplied keypair (the managed-account path);
 * Story 2.4's wallet path uses the split fetch/submit functions instead. */
export async function runAnchorSep10(
  params: RunAnchorSep10Params,
  fetchImpl: Sep10FetchLike = defaultFetch,
): Promise<AnchorSep10Result> {
  const { signer, ...challengeParams } = params;
  const { unsignedXdr } = await fetchAnchorSep10Challenge(challengeParams, fetchImpl);
  const transaction: Transaction = TransactionBuilder.fromXdr(unsignedXdr, challengeParams.networkPassphrase) as Transaction;
  transaction.sign(signer);
  return submitAnchorSep10Challenge({ ...challengeParams, signedXdr: transaction.toXdr() }, fetchImpl);
}
