/**
 * Fetches and parses `ANCHOR_HOME_DOMAIN`'s `stellar.toml` for the SEP
 * endpoints this story (and later ones) need -- never the USDC currency
 * `scripts/src/toml.ts` resolves; different data, same discovery discipline
 * (AD-10). Re-derives that module's shape (pure parsing, a thin injectable
 * `fetch` seam defaulting to the real network call) rather than importing
 * it: `backend` and `scripts` are separate npm workspaces.
 *
 * Every endpoint returned here comes only from the fetched body -- nothing
 * is ever hard-coded, and the story's own manual check (`git grep` for a
 * literal SEP-10 URL) is exactly what this module exists to make pass.
 */
import { parse } from "smol-toml";

import { AnchorDiscoveryError } from "./errors.js";

const STELLAR_TOML_PATH = "/.well-known/stellar.toml";
// A host that accepts the connection and never answers must not hang the
// caller forever with no output and no exit.
const REQUEST_TIMEOUT_MS = 10_000;

/** Minimal shape this module needs from `fetch`, so a test can stub it
 * without touching the network -- same shape as `scripts/src/anchor.ts`'s
 * `FetchLike`. */
export type FetchLike = (url: string) => Promise<Pick<Response, "ok" | "status" | "text">>;

function defaultFetch(url: string): Promise<Pick<Response, "ok" | "status" | "text">> {
  return fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** Fetches `homeDomain`'s `stellar.toml` body. Throws
 * {@link AnchorDiscoveryError}, naming the domain, on any network failure
 * or non-OK response -- nothing proceeds to parsing, let alone the anchor's
 * SEP-10 exchange, past this point. */
export async function fetchAnchorToml(homeDomain: string, fetchImpl: FetchLike = defaultFetch): Promise<string> {
  const url = `https://${homeDomain}${STELLAR_TOML_PATH}`;
  let response: Pick<Response, "ok" | "status" | "text">;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorDiscoveryError(`Could not reach ${homeDomain} (${url}): ${reason}`);
  }
  if (!response.ok) {
    throw new AnchorDiscoveryError(`${homeDomain} returned HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

/** The anchor's SEP endpoints, exactly as declared in its `stellar.toml` --
 * `webAuthEndpoint` and `signingKey` are required (this story's own SEP-10
 * exchange cannot proceed without them); the rest are optional because
 * later stories, not this one, are the first to need them. */
export interface AnchorSepEndpoints {
  /** SEP-10's own endpoint. */
  webAuthEndpoint: string;
  /** The anchor's signing key, used to confirm a SEP-10 challenge really
   * came from this anchor before this backend ever signs one. */
  signingKey: string;
  /** SEP-6, read here (not called) so Story 2.3/2.4 do not have to
   * re-parse `stellar.toml` themselves. */
  transferServer?: string;
  /** SEP-12. */
  kycServer?: string;
  /** SEP-38. */
  quoteServer?: string;
}

function requireField(toml: Record<string, unknown>, key: string, homeDomain: string): string {
  const value = toml[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AnchorDiscoveryError(`${homeDomain}'s stellar.toml is missing required field "${key}"`);
  }
  return value.trim();
}

function optionalField(toml: Record<string, unknown>, key: string): string | undefined {
  const value = toml[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Parses a fetched `stellar.toml` body into the SEP endpoints this backend
 * reads. Pure text-in, value-out -- no network call lives here, only the
 * decision of what the fetched body means (mirrors `scripts/src/toml.ts`'s
 * `resolveUsdcAsset`). */
export function parseSepEndpoints(tomlBody: string, homeDomain: string): AnchorSepEndpoints {
  let parsed: unknown;
  try {
    parsed = parse(tomlBody);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorDiscoveryError(`${homeDomain}'s stellar.toml is not valid TOML: ${reason}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AnchorDiscoveryError(`${homeDomain}'s stellar.toml did not parse to a table`);
  }
  const table = parsed as Record<string, unknown>;
  return {
    webAuthEndpoint: requireField(table, "WEB_AUTH_ENDPOINT", homeDomain),
    signingKey: requireField(table, "SIGNING_KEY", homeDomain),
    transferServer: optionalField(table, "TRANSFER_SERVER"),
    kycServer: optionalField(table, "KYC_SERVER"),
    quoteServer: optionalField(table, "ANCHOR_QUOTE_SERVER"),
  };
}

/** Fetches and parses `homeDomain`'s `stellar.toml` in one call -- the
 * entry point `../services/auth.ts` uses. */
export async function discoverAnchorSepEndpoints(
  homeDomain: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<AnchorSepEndpoints> {
  const body = await fetchAnchorToml(homeDomain, fetchImpl);
  return parseSepEndpoints(body, homeDomain);
}
