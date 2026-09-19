/**
 * Fetches the anchor's `stellar.toml` and resolves its USDC asset. The only
 * job here is the network call; the parsing and asset-selection logic that
 * decides what the body means lives in `toml.ts` and is unit-tested there.
 */
import { parseCurrencies, resolveUsdcAsset, type UsdcAsset } from "./toml.js";

const STELLAR_TOML_PATH = "/.well-known/stellar.toml";
// A host that accepts the connection and never answers must not hang the
// command forever with no output and no exit.
const REQUEST_TIMEOUT_MS = 10_000;

export class AnchorUnreachableError extends Error {}

/** Minimal shape this module needs from `fetch`, so a test can stub it. */
export type FetchLike = (url: string) => Promise<Pick<Response, "ok" | "status" | "text">>;

function defaultFetch(url: string): Promise<Pick<Response, "ok" | "status" | "text">> {
  return fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export async function fetchAnchorToml(homeDomain: string, fetchImpl: FetchLike = defaultFetch): Promise<string> {
  const url = `https://${homeDomain}${STELLAR_TOML_PATH}`;
  let response: Pick<Response, "ok" | "status" | "text">;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnreachableError(`Could not reach ${homeDomain} (${url}): ${reason}`);
  }
  if (!response.ok) {
    throw new AnchorUnreachableError(`${homeDomain} returned HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

/** Fetches `homeDomain`'s `stellar.toml` and returns its USDC issuer and code. */
export async function resolveAnchorUsdcAsset(
  homeDomain: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<UsdcAsset> {
  const body = await fetchAnchorToml(homeDomain, fetchImpl);
  const currencies = parseCurrencies(body);
  return resolveUsdcAsset(currencies, "USDC");
}
