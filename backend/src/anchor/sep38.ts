/**
 * Story 2.2: the anchor's SEP-38 indicative price -- read-only, never a
 * firm `quote_id` reservation (that belongs to Stories 2.3/2.4, which
 * actually move money). Every amount in the product is USDC; this is the
 * one place that asks the anchor's own `sep38/price` what a USDC amount is
 * worth in whatever fiat currency the anchor advertises (NFR12: never a
 * hard-coded TRY), so the client can see the local-currency equivalent
 * before paying.
 *
 * Endpoint discovery reuses `stellar-toml.ts`'s `discoverAnchorSepEndpoints`
 * (`ANCHOR_QUOTE_SERVER`, AD-10) and `usdc.ts`'s resolved USDC asset --
 * never a constant. Every network stage sits behind one injectable
 * `fetch`-shaped seam defaulting to the real implementation, the same
 * `sep10.ts`/`chain/client.ts` discipline: a caller that overrides it never
 * reaches `tr-mock-anchor.fly.dev`, and a caller that does not gets the
 * real network.
 *
 * Two separate caches, per the spec's own "Always" rules:
 *  - the anchor's *support* (its quote server URL, the sell asset id, and
 *    whichever fiat currency it advertises) is resolved once and cached,
 *    mirroring `usdc.ts`'s "resolved once and cached" discipline -- it
 *    almost never changes within a process's lifetime;
 *  - the *price* itself is cached briefly (about 60 seconds), keyed by the
 *    pair and the amount rounded to the fiat's own display precision (2
 *    decimal places for USDC, per the anchor's `stellar.toml` currency
 *    entry) -- fine enough that no card ever shows a stale cent, coarse
 *    enough that a Discover page full of cards showing visually identical
 *    amounts does not hammer the anchor with one request per pixel of
 *    difference below what anyone can see.
 */
import { config } from "../config.js";
import { AnchorQuoteUnavailableError, AnchorQuoteUnsupportedError } from "./errors.js";
import { discoverAnchorSepEndpoints } from "./stellar-toml.js";
import { resolveUsdcAsset } from "./usdc.js";

const REQUEST_TIMEOUT_MS = 10_000;
const PRICE_CACHE_TTL_MS = 60_000;

/** USDC on Stellar: 7 decimal places (AD-7's smallest unit end to end),
 * matching `frontend/src/lib/money.ts` and `escrow/trustless-work/
 * reconciler.ts`'s `humanDecimalToSmallestUnits`. */
const SMALLEST_UNIT_DECIMALS = 7;
/** The anchor's own USDC `display_decimals` (its `stellar.toml`'s
 * `[[CURRENCIES]]` entry) -- also the granularity the price cache rounds
 * to, since no display ever shows finer than this. */
const DISPLAY_DECIMALS = 2;
const CACHE_ROUNDING_UNIT = 10n ** BigInt(SMALLEST_UNIT_DECIMALS - DISPLAY_DECIMALS);

/** Minimal shape this module needs from `fetch` -- a superset of
 * `stellar-toml.ts`'s `FetchLike` (adds `.json()`), so the one seam a
 * caller injects here also satisfies `discoverAnchorSepEndpoints`'s and
 * `resolveUsdcAsset`'s own `FetchLike` parameter. */
export type Sep38FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

function defaultFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
): Promise<Pick<Response, "ok" | "status" | "json" | "text">> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** Reads a JSON body, translating a body that is not valid JSON (or a
 * network read failure) into `undefined` rather than letting a raw parse
 * error escape -- callers decide what a missing/unreadable body means. */
async function tryReadJson(response: Pick<Response, "json">): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Pulls the anchor's own explanation out of an error response body. The
 * mock anchor's SEP-38 errors are inconsistent in shape -- sometimes a
 * plain `{"error": "..."}` string (matching `llms-full.txt`'s documented
 * shape), sometimes `{"error": {"code", "message"}}` -- so both are read
 * rather than only the documented one. */
function anchorReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  return undefined;
}

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

interface AnchorQuoteConfig {
  quoteServer: string;
  /** SEP-38's `stellar:CODE:ISSUER` form. */
  sellAsset: string;
  /** SEP-38's `iso4217:CODE` form. */
  buyAsset: string;
  /** The USDC code as this backend's users know it (usually `"USDC"`). */
  assetCode: string;
  /** The fiat currency code, read from the anchor's own `sep38/info` --
   * never hard-coded (NFR12). */
  currency: string;
}

let cachedConfig: AnchorQuoteConfig | undefined;

interface Sep38InfoAsset {
  asset?: unknown;
}

/** Resolves and caches the anchor's SEP-38 support: its quote server, the
 * USDC sell-asset id, and whichever fiat currency it advertises alongside
 * it. Throws {@link AnchorQuoteUnavailableError} if the anchor cannot be
 * reached or its `stellar.toml`/`sep38/info` do not parse, and
 * {@link AnchorQuoteUnsupportedError} if the anchor simply does not offer
 * this pair. */
async function resolveQuoteConfig(fetchImpl: Sep38FetchLike, forceRefresh: boolean): Promise<AnchorQuoteConfig> {
  if (cachedConfig && !forceRefresh) {
    return cachedConfig;
  }

  const homeDomain = config.anchorHomeDomain;
  let endpoints;
  let usdc;
  try {
    [endpoints, usdc] = await Promise.all([
      discoverAnchorSepEndpoints(homeDomain, fetchImpl),
      resolveUsdcAsset({ fetchImpl, forceRefresh }),
    ]);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorQuoteUnavailableError(`Could not resolve ${homeDomain}'s SEP-38 support: ${reason}`);
  }
  if (!endpoints.quoteServer) {
    throw new AnchorQuoteUnavailableError(`${homeDomain}'s stellar.toml does not declare ANCHOR_QUOTE_SERVER`);
  }
  const sellAsset = `stellar:${usdc.code}:${usdc.issuer}`;

  let infoResponse: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    infoResponse = await fetchImpl(`${endpoints.quoteServer}/info`);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorQuoteUnavailableError(`Could not reach ${homeDomain}'s SEP-38 info endpoint: ${reason}`);
  }
  if (!infoResponse.ok) {
    const reason = await anchorReasonFromResponse(infoResponse);
    throw new AnchorQuoteUnavailableError(
      `${homeDomain} refused the SEP-38 info request (HTTP ${infoResponse.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  const infoBody = await tryReadJson(infoResponse);
  const assets =
    typeof infoBody === "object" && infoBody !== null && Array.isArray((infoBody as { assets?: unknown }).assets)
      ? ((infoBody as { assets: Sep38InfoAsset[] }).assets ?? [])
      : undefined;
  if (!assets) {
    throw new AnchorQuoteUnavailableError(`${homeDomain}'s SEP-38 info response did not include an assets list`);
  }
  const sellSupported = assets.some((entry) => entry.asset === sellAsset);
  if (!sellSupported) {
    throw new AnchorQuoteUnsupportedError(`${homeDomain}'s SEP-38 does not offer ${sellAsset}`);
  }
  const fiatEntry = assets.find(
    (entry) => typeof entry.asset === "string" && entry.asset.startsWith("iso4217:") && entry.asset !== sellAsset,
  );
  if (!fiatEntry || typeof fiatEntry.asset !== "string") {
    throw new AnchorQuoteUnsupportedError(`${homeDomain}'s SEP-38 does not advertise a fiat currency alongside ${sellAsset}`);
  }
  const buyAsset = fiatEntry.asset;
  const currency = buyAsset.slice("iso4217:".length);
  if (!currency) {
    throw new AnchorQuoteUnsupportedError(`${homeDomain}'s SEP-38 advertised a fiat asset with no currency code: "${buyAsset}"`);
  }

  cachedConfig = { quoteServer: endpoints.quoteServer, sellAsset, buyAsset, assetCode: usdc.code, currency };
  return cachedConfig;
}

/** Test-only: clears both the config and price caches so each test starts
 * fresh. */
export function resetSep38CacheForTests(): void {
  cachedConfig = undefined;
  priceCache.clear();
}

/** Renders an integer smallest-unit amount as the plain decimal string
 * SEP-38's `sell_amount` takes (`"450.0000000"`), using exact
 * string/bigint arithmetic -- never `Number(...)`, never a float. */
function smallestUnitsToDecimalString(amount: bigint, decimals = SMALLEST_UNIT_DECIMALS): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

interface CachedPrice {
  fiatAmount: string;
  currency: string;
  quotedAtMs: number;
}

const priceCache = new Map<string, CachedPrice>();

export interface FetchIndicativePriceParams {
  /** Integer string, USDC smallest units (AD-7). Must already be a
   * positive integer string -- this module does not re-validate shape,
   * since the route (`GET /quote`) refuses a bad amount before ever
   * calling here (the spec's own "Refused before any anchor call"). */
  amount: string;
}

export interface FetchIndicativePriceOptions {
  /** Overrides every network call this makes (toml discovery, USDC
   * resolution, and the SEP-38 calls themselves) -- defaults to the real
   * network. */
  fetchImpl?: Sep38FetchLike;
  /** Epoch milliseconds -- defaults to `Date.now()`. A test's own seam for
   * the cache TTL and the returned `quotedAt`. */
  now?: () => number;
  /** Bypasses (and, on success, refreshes) both caches -- a test's own
   * concern; the real caller never sets this. */
  forceRefresh?: boolean;
}

export interface IndicativePrice {
  /** Echoes the request: integer string, USDC smallest units. */
  amount: string;
  /** The USDC code, e.g. `"USDC"`. */
  asset: string;
  fiat: {
    /** A plain decimal string, e.g. `"14350.00"` -- display-only, never
     * persisted on a booking and never used to compute a deposit (AD-7). */
    amount: string;
    /** Whatever the anchor advertises (`sep38/info`), never a hard-coded
     * TRY (NFR12). */
    currency: string;
  };
  /** Epoch seconds -- this codebase's own convention
   * (`services/booking.ts`'s `holdExpiresAt`), not a Date object. */
  quotedAt: number;
  /** Always `true`: the anchor's own SEP-38 price already carries its
   * 0.5% spread, so Pactly never adds or recomputes one of its own. */
  spreadApplied: true;
}

/** Fetches the anchor's SEP-38 indicative price for `amount` (USDC
 * smallest units) in whatever fiat currency the anchor advertises. Cached
 * briefly (about 60 seconds) per pair and amount, rounded to the fiat's
 * own display precision. Throws {@link AnchorQuoteUnavailableError} if the
 * anchor cannot be reached or its response cannot be used, and
 * {@link AnchorQuoteUnsupportedError} if the anchor does not offer this
 * pair -- the route (`GET /quote`) maps both to a safe, plain-sentence
 * response; the USDC amount itself is never blocked by either. */
export async function fetchIndicativePrice(
  { amount }: FetchIndicativePriceParams,
  options: FetchIndicativePriceOptions = {},
): Promise<IndicativePrice> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const nowMs = options.now ? options.now() : Date.now();
  const amountUnits = BigInt(amount);

  const cfg = await resolveQuoteConfig(fetchImpl, options.forceRefresh ?? false);

  const roundedAmount = (amountUnits / CACHE_ROUNDING_UNIT) * CACHE_ROUNDING_UNIT;
  const cacheKey = `${cfg.sellAsset}|${cfg.buyAsset}|${roundedAmount.toString()}`;
  const cached = options.forceRefresh ? undefined : priceCache.get(cacheKey);
  if (cached && nowMs - cached.quotedAtMs < PRICE_CACHE_TTL_MS) {
    return {
      amount,
      asset: cfg.assetCode,
      fiat: { amount: cached.fiatAmount, currency: cached.currency },
      quotedAt: Math.floor(cached.quotedAtMs / 1000),
      spreadApplied: true,
    };
  }

  const url = new URL(`${cfg.quoteServer}/price`);
  url.searchParams.set("sell_asset", cfg.sellAsset);
  url.searchParams.set("buy_asset", cfg.buyAsset);
  url.searchParams.set("sell_amount", smallestUnitsToDecimalString(amountUnits));

  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(url.toString());
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorQuoteUnavailableError(`Could not reach ${config.anchorHomeDomain}'s SEP-38 price endpoint: ${reason}`);
  }
  if (!response.ok) {
    const reason = await anchorReasonFromResponse(response);
    if (response.status === 400 && reason && /unsupported/i.test(reason)) {
      throw new AnchorQuoteUnsupportedError(`${config.anchorHomeDomain} does not support this quote${reason ? `: ${reason}` : ""}`);
    }
    throw new AnchorQuoteUnavailableError(
      `${config.anchorHomeDomain} refused the SEP-38 price request (HTTP ${response.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  const body = await tryReadJson(response);
  const buyAmount = typeof body === "object" && body !== null ? (body as { buy_amount?: unknown }).buy_amount : undefined;
  if (typeof buyAmount !== "string" || buyAmount.trim() === "") {
    throw new AnchorQuoteUnavailableError(`${config.anchorHomeDomain}'s SEP-38 price response did not include buy_amount`);
  }
  const fiatAmount = buyAmount.trim();

  priceCache.set(cacheKey, { fiatAmount, currency: cfg.currency, quotedAtMs: nowMs });

  return {
    amount,
    asset: cfg.assetCode,
    fiat: { amount: fiatAmount, currency: cfg.currency },
    quotedAt: Math.floor(nowMs / 1000),
    spreadApplied: true,
  };
}
