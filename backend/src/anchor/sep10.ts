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

export interface RunAnchorSep10Params {
  webAuthEndpoint: string;
  /** From `stellar.toml`'s `SIGNING_KEY` -- the anchor's own account, used
   * to confirm the challenge this backend is about to sign really came from
   * the anchor. */
  signingKey: string;
  homeDomain: string;
  networkPassphrase: string;
  /** The wallet the JWT should be issued for. */
  account: string;
  /** Signs the anchor's challenge -- caller-supplied because this backend
   * never holds a user's real wallet key; later stories pass a managed
   * account's key here instead. */
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

/** Pulls the anchor's own explanation out of an error response body, if it
 * supplied one -- the I/O matrix's "surfacing the anchor's own reason". */
function anchorReason(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim() !== "") return error.trim();
  }
  return undefined;
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
  return exp * 1000;
}

/** Runs the anchor's real SEP-10 exchange end to end and returns its JWT.
 * Nothing is stored here -- storing the result, keyed by wallet address, is
 * `../services/auth.ts`'s job, so this module stays a pure network client. */
export async function runAnchorSep10(
  params: RunAnchorSep10Params,
  fetchImpl: Sep10FetchLike = defaultFetch,
): Promise<AnchorSep10Result> {
  const { webAuthEndpoint, signingKey, homeDomain, networkPassphrase, account, signer } = params;

  let challengeResponse: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    challengeResponse = await fetchImpl(`${webAuthEndpoint}?account=${encodeURIComponent(account)}`, { method: "GET" });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorAuthError(`Could not reach ${homeDomain}'s SEP-10 endpoint: ${reason}`);
  }
  const challengeBody = (await readJson(challengeResponse, homeDomain)) as ChallengeResponseBody;
  if (!challengeResponse.ok) {
    const reason = anchorReason(challengeBody);
    throw new AnchorAuthError(
      `${homeDomain} refused the SEP-10 challenge request (HTTP ${challengeResponse.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  if (typeof challengeBody.transaction !== "string" || challengeBody.transaction.trim() === "") {
    throw new AnchorAuthError(`${homeDomain}'s SEP-10 challenge response did not include a transaction`);
  }
  const challengeXdr = challengeBody.transaction;

  // Confirm this really is a challenge from the anchor -- signed by its own
  // `SIGNING_KEY`, naming its own home domain -- before this backend ever
  // signs it. Uses the SDK's own reader, never a hand-rolled check.
  try {
    WebAuth.readChallengeTx(challengeXdr, signingKey, networkPassphrase, homeDomain, new URL(webAuthEndpoint).host);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorAuthError(`${homeDomain}'s SEP-10 challenge did not pass validation: ${reason}`);
  }

  const transaction: Transaction = TransactionBuilder.fromXdr(challengeXdr, networkPassphrase) as Transaction;
  transaction.sign(signer);
  const signedXdr = transaction.toXdr();

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
  const tokenBody = (await readJson(tokenResponse, homeDomain)) as TokenResponseBody;
  if (!tokenResponse.ok) {
    const reason = anchorReason(tokenBody);
    throw new AnchorAuthError(
      `${homeDomain} rejected the signed SEP-10 challenge (HTTP ${tokenResponse.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  if (typeof tokenBody.token !== "string" || tokenBody.token.trim() === "") {
    throw new AnchorAuthError(`${homeDomain}'s SEP-10 response did not include a token`);
  }

  return { token: tokenBody.token, expiresAt: decodeJwtExpiryMs(tokenBody.token, homeDomain) };
}
