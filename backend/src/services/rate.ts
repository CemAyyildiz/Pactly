/**
 * `GET /rate`: the local-currency price of one USDC, so the frontend can
 * show every amount in TRY without ever naming USDC. Derived from the
 * anchor's own SEP-38 indicative price for exactly 1 USDC
 * (`fetchIndicativePrice({ amount: "10000000" })` -- 7 decimals), never a
 * hard-coded rate (NFR12); the currency is whatever the anchor advertises,
 * which for this anchor is TRY.
 *
 * Cached in-process for 60 seconds. When the anchor is unreachable the last
 * good rate is served (with its original `quotedAt`, so a caller can see
 * it is stale) rather than failing the whole page; only with no good
 * value ever fetched does this throw {@link RateUnavailableError}.
 */
import { fetchIndicativePrice, type Sep38FetchLike } from "../anchor/sep38.js";

/** 1 USDC in smallest units (7 decimals). */
const ONE_USDC = "10000000";
const RATE_CACHE_TTL_MS = 60_000;

export class RateUnavailableError extends Error {
  constructor(message = "The exchange rate is unavailable right now.") {
    super(message);
    this.name = "RateUnavailableError";
  }
}

export interface TryRate {
  /** Local currency per 1 USDC, a plain decimal string (e.g. `"41.20"`). */
  rate: string;
  /** The anchor's advertised fiat currency -- `"TRY"`. */
  currency: string;
  /** Epoch seconds the underlying price was fetched at. */
  quotedAt: number;
}

export interface GetTryRateOptions {
  fetchImpl?: Sep38FetchLike;
  /** Epoch milliseconds -- defaults to `Date.now()`. */
  now?: () => number;
}

let cached: { value: TryRate; fetchedAtMs: number } | undefined;

export async function getTryRate(options: GetTryRateOptions = {}): Promise<TryRate> {
  const nowMs = options.now ? options.now() : Date.now();
  if (cached && nowMs - cached.fetchedAtMs < RATE_CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const price = await fetchIndicativePrice(
      { amount: ONE_USDC },
      { fetchImpl: options.fetchImpl, now: options.now, forceRefresh: true },
    );
    const value: TryRate = { rate: price.fiat.amount, currency: price.fiat.currency, quotedAt: price.quotedAt };
    cached = { value, fetchedAtMs: nowMs };
    return value;
  } catch (error) {
    if (cached) {
      return cached.value;
    }
    throw new RateUnavailableError(
      `Could not fetch the exchange rate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Test-only: clears the cache so each test starts fresh. */
export function resetRateCacheForTests(): void {
  cached = undefined;
}
