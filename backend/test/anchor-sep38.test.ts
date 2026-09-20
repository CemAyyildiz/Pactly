/**
 * `anchor/sep38.ts` exercised as a unit: every network stage goes through
 * the injected `Sep38FetchLike` seam, so nothing here ever reaches
 * `tr-mock-anchor.fly.dev`. The fixture payload shapes (`sep38/info`'s
 * `assets` list, `sep38/price`'s `buy_amount`) mirror the real anchor's own
 * responses, recorded manually against `https://tr-mock-anchor.fly.dev`
 * while writing this client -- see the spec's own "you may call the live
 * sandbox to learn its exact response shapes" note. Covers every row of
 * Story 2.2's I/O matrix except the two HTTP-boundary rows (`Bad amount`,
 * `Booking screen`), which `app-quote.test.ts` covers instead.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchIndicativePrice, resetSep38CacheForTests, type Sep38FetchLike } from "../src/anchor/sep38.js";
import { AnchorQuoteUnavailableError, AnchorQuoteUnsupportedError } from "../src/anchor/errors.js";
import { resetUsdcAssetCacheForTests } from "../src/anchor/usdc.js";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SELL_ASSET = `stellar:USDC:${USDC_ISSUER}`;

const REALISTIC_TOML = `
VERSION="2.0.0"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
WEB_AUTH_ENDPOINT="https://tr-mock-anchor.fly.dev/auth"
SIGNING_KEY="GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY"
ANCHOR_QUOTE_SERVER="https://tr-mock-anchor.fly.dev/sep38"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
`;

const SEP38_INFO_BODY = {
  assets: [
    { asset: SELL_ASSET },
    {
      asset: "iso4217:TRY",
      country_codes: ["TUR"],
      sell_delivery_methods: [{ name: "bank_account", description: "Turkish bank transfer" }],
      buy_delivery_methods: [{ name: "bank_account", description: "Turkish bank transfer" }],
    },
  ],
};

interface RouterCalls {
  toml: number;
  info: number;
  price: string[];
}

/** Builds a fetch router over the three URLs this module ever calls, with
 * the price leg's response and status swappable per test. */
function makeRouter(
  priceHandler: (url: URL) => { status: number; body: unknown },
  calls: RouterCalls = { toml: 0, info: 0, price: [] },
): Sep38FetchLike {
  const fetchImpl: Sep38FetchLike = async (url) => {
    if (url.endsWith("/.well-known/stellar.toml")) {
      calls.toml += 1;
      return { ok: true, status: 200, text: async () => REALISTIC_TOML, json: async () => ({}) };
    }
    if (url.endsWith("/sep38/info")) {
      calls.info += 1;
      return { ok: true, status: 200, json: async () => SEP38_INFO_BODY, text: async () => JSON.stringify(SEP38_INFO_BODY) };
    }
    const parsed = new URL(url);
    if (parsed.pathname === "/sep38/price") {
      calls.price.push(url);
      const { status, body } = priceHandler(parsed);
      return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };
  return fetchImpl;
}

function resetCaches(): void {
  resetSep38CacheForTests();
  resetUsdcAssetCacheForTests();
}

test("fetchIndicativePrice returns the anchor's indicative price, with the currency read from sep38/info (not hard-coded)", async () => {
  resetCaches();
  const calls: RouterCalls = { toml: 0, info: 0, price: [] };
  const fetchImpl = makeRouter(
    (url) => {
      assert.equal(url.searchParams.get("sell_asset"), SELL_ASSET);
      assert.equal(url.searchParams.get("buy_asset"), "iso4217:TRY");
      assert.equal(url.searchParams.get("sell_amount"), "450.0000000");
      return {
        status: 200,
        body: { total_price: "0.0206010847", price: "0.0204980712", sell_amount: "450.0000000", buy_amount: "21843.51" },
      };
    },
    calls,
  );

  const result = await fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl });

  assert.equal(result.amount, "4500000000");
  assert.equal(result.asset, "USDC");
  assert.deepEqual(result.fiat, { amount: "21843.51", currency: "TRY" });
  assert.equal(result.spreadApplied, true);
  assert.equal(typeof result.quotedAt, "number");
  assert.equal(calls.price.length, 1);
});

test("a second call for the same pair and (rounded) amount within the cache window is served from cache -- quotedAt unchanged, no second anchor call", async () => {
  resetCaches();
  const calls: RouterCalls = { toml: 0, info: 0, price: [] };
  const fetchImpl = makeRouter(() => ({ status: 200, body: { buy_amount: "21843.51" } }), calls);
  let nowMs = 1_000_000;
  const now = () => nowMs;

  const first = await fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl, now });
  nowMs += 5_000;
  const second = await fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl, now });

  assert.equal(calls.price.length, 1, "the price endpoint is called only once");
  assert.equal(second.quotedAt, first.quotedAt, "the cached quotedAt is unchanged");
  assert.deepEqual(second.fiat, first.fiat);
});

test("a call after the cache window has passed re-fetches from the anchor", async () => {
  resetCaches();
  const calls: RouterCalls = { toml: 0, info: 0, price: [] };
  const fetchImpl = makeRouter(() => ({ status: 200, body: { buy_amount: "21843.51" } }), calls);
  let nowMs = 1_000_000;
  const now = () => nowMs;

  await fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl, now });
  nowMs += 61_000;
  await fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl, now });

  assert.equal(calls.price.length, 2);
});

test("the anchor being unreachable throws AnchorQuoteUnavailableError, naming the domain", async () => {
  resetCaches();
  const fetchImpl: Sep38FetchLike = async () => {
    throw new Error("getaddrinfo ENOTFOUND tr-mock-anchor.fly.dev");
  };

  await assert.rejects(
    () => fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl }),
    (error: unknown) => error instanceof AnchorQuoteUnavailableError && error.message.includes("tr-mock-anchor.fly.dev"),
  );
});

test("a non-200 from the price endpoint throws AnchorQuoteUnavailableError, surfacing the anchor's own reason", async () => {
  resetCaches();
  const calls: RouterCalls = { toml: 0, info: 0, price: [] };
  const fetchImpl = makeRouter(() => ({ status: 503, body: { error: "temporarily unavailable" } }), calls);

  await assert.rejects(
    () => fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl }),
    (error: unknown) => error instanceof AnchorQuoteUnavailableError && /temporarily unavailable/.test(error.message),
  );
});

test("an unsupported pair (sep38/info never advertises the sell asset) throws AnchorQuoteUnsupportedError before any price call", async () => {
  resetCaches();
  const calls: RouterCalls = { toml: 0, info: 0, price: [] };
  const fetchImpl: Sep38FetchLike = async (url) => {
    if (url.endsWith("/.well-known/stellar.toml")) {
      calls.toml += 1;
      return { ok: true, status: 200, text: async () => REALISTIC_TOML, json: async () => ({}) };
    }
    if (url.endsWith("/sep38/info")) {
      calls.info += 1;
      return { ok: true, status: 200, json: async () => ({ assets: [{ asset: "iso4217:TRY" }] }), text: async () => "" };
    }
    calls.price.push(url);
    throw new Error("must not be called");
  };

  await assert.rejects(
    () => fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl }),
    (error: unknown) => error instanceof AnchorQuoteUnsupportedError,
  );
  assert.equal(calls.price.length, 0);
});

test("the anchor's own 'unsupported pair' error from the price endpoint maps to AnchorQuoteUnsupportedError", async () => {
  resetCaches();
  const calls: RouterCalls = { toml: 0, info: 0, price: [] };
  const fetchImpl = makeRouter(
    () => ({ status: 400, body: { error: "unsupported asset pair; supported: iso4217:TRY <-> " + SELL_ASSET } }),
    calls,
  );

  await assert.rejects(
    () => fetchIndicativePrice({ amount: "4500000000" }, { fetchImpl }),
    (error: unknown) => error instanceof AnchorQuoteUnsupportedError,
  );
});
