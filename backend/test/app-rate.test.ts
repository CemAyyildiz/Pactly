/**
 * `GET /rate` (passkey pivot): TRY per 1 USDC from the anchor's SEP-38
 * price, cached a minute, served stale on failure, `503 RATE_UNAVAILABLE`
 * only with a cold cache. The anchor fetch is faked the same way
 * `app-quote.test.ts` does.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { resetSep38CacheForTests, type Sep38FetchLike } from "../src/anchor/sep38.js";
import { resetUsdcAssetCacheForTests } from "../src/anchor/usdc.js";
import { RateUnavailableError, getTryRate, resetRateCacheForTests } from "../src/services/rate.js";
import { openTestDatabase, closeDatabase } from "./helpers.js";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SELL_ASSET = `stellar:USDC:${USDC_ISSUER}`;
const REALISTIC_TOML = `
WEB_AUTH_ENDPOINT="https://tr-mock-anchor.fly.dev/auth"
SIGNING_KEY="GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY"
ANCHOR_QUOTE_SERVER="https://tr-mock-anchor.fly.dev/sep38"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
`;
const SEP38_INFO_BODY = { assets: [{ asset: SELL_ASSET }, { asset: "iso4217:TRY" }] };

function resetCaches(): void {
  resetSep38CacheForTests();
  resetUsdcAssetCacheForTests();
  resetRateCacheForTests();
}

function makeFetch(state: { priceCalls: number; priceUrls: string[]; fail: boolean; buyAmount: string }): Sep38FetchLike {
  return async (url) => {
    if (state.fail) throw new Error("getaddrinfo ENOTFOUND tr-mock-anchor.fly.dev");
    if (url.endsWith("/.well-known/stellar.toml")) {
      return { ok: true, status: 200, text: async () => REALISTIC_TOML, json: async () => ({}) };
    }
    if (url.endsWith("/sep38/info")) {
      return { ok: true, status: 200, json: async () => SEP38_INFO_BODY, text: async () => JSON.stringify(SEP38_INFO_BODY) };
    }
    state.priceCalls += 1;
    state.priceUrls.push(url);
    return { ok: true, status: 200, json: async () => ({ buy_amount: state.buyAmount }), text: async () => "" };
  };
}

test("GET /rate returns TRY per 1 USDC from a 1-USDC SEP-38 price, cached across calls", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const state = { priceCalls: 0, priceUrls: [] as string[], fail: false, buyAmount: "41.20" };
    const app = createApp(result.db, { rateFetchImpl: makeFetch(state) });
    const first = await app.request("/rate");
    assert.equal(first.status, 200);
    const body = (await first.json()) as { rate: string; currency: string; quotedAt: number };
    assert.equal(body.rate, "41.20");
    assert.equal(body.currency, "TRY");
    assert.equal(typeof body.quotedAt, "number");
    assert.ok(state.priceUrls[0]?.includes("sell_amount=1.0000000"));

    const second = await app.request("/rate");
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), body);
    assert.equal(state.priceCalls, 1);
  } finally {
    closeDatabase(result);
  }
});

test("GET /rate falls back to quoteFetchImpl when no rate-specific fetch is given", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const state = { priceCalls: 0, priceUrls: [] as string[], fail: false, buyAmount: "40.00" };
    const app = createApp(result.db, { quoteFetchImpl: makeFetch(state) });
    const response = await app.request("/rate");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { rate: string }).rate, "40.00");
  } finally {
    closeDatabase(result);
  }
});

test("GET /rate with a cold cache and an unreachable anchor is 503 RATE_UNAVAILABLE, never a raw error", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const state = { priceCalls: 0, priceUrls: [] as string[], fail: true, buyAmount: "41.20" };
    const app = createApp(result.db, { rateFetchImpl: makeFetch(state) });
    const response = await app.request("/rate");
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string; message: string };
    assert.equal(body.code, "RATE_UNAVAILABLE");
    assert.ok(!/ENOTFOUND/.test(body.message));
  } finally {
    closeDatabase(result);
  }
});

test("getTryRate serves the last good rate once the cache is stale and the anchor is down, and refreshes when it is back", async () => {
  resetCaches();
  const state = { priceCalls: 0, priceUrls: [] as string[], fail: false, buyAmount: "41.20" };
  const fetchImpl = makeFetch(state);
  let now = 1_700_000_000_000;
  const clock = () => now;

  const fresh = await getTryRate({ fetchImpl, now: clock });
  assert.equal(fresh.rate, "41.20");
  assert.equal(fresh.quotedAt, Math.floor(now / 1000));

  now += 61_000;
  state.fail = true;
  const stale = await getTryRate({ fetchImpl, now: clock });
  assert.deepEqual(stale, fresh, "the last good value, with its original quotedAt");

  state.fail = false;
  state.buyAmount = "42.00";
  resetSep38CacheForTests();
  resetUsdcAssetCacheForTests();
  const refreshed = await getTryRate({ fetchImpl, now: clock });
  assert.equal(refreshed.rate, "42.00");
  assert.equal(refreshed.quotedAt, Math.floor(now / 1000));

  resetRateCacheForTests();
  state.fail = true;
  await assert.rejects(getTryRate({ fetchImpl, now: clock }), RateUnavailableError);
});
