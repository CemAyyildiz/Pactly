/**
 * Story 2.2's `GET /quote`, driven through Hono's own `app.request(...)`
 * like `app-providers.test.ts`. Covers the I/O matrix's HTTP-boundary rows
 * (`Bad amount`, `Anchor down`, `Unsupported pair`) and the success shape;
 * `anchor-sep38.test.ts` covers the anchor client's own caching and error
 * mapping underneath. `quoteFetchImpl` (this story's own `CreateAppOptions`
 * addition) keeps every call here off the real anchor.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { resetSep38CacheForTests, type Sep38FetchLike } from "../src/anchor/sep38.js";
import { resetUsdcAssetCacheForTests } from "../src/anchor/usdc.js";
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
}

function makeFetch(priceStatus: number, priceBody: unknown): Sep38FetchLike {
  return async (url) => {
    if (url.endsWith("/.well-known/stellar.toml")) {
      return { ok: true, status: 200, text: async () => REALISTIC_TOML, json: async () => ({}) };
    }
    if (url.endsWith("/sep38/info")) {
      return { ok: true, status: 200, json: async () => SEP38_INFO_BODY, text: async () => JSON.stringify(SEP38_INFO_BODY) };
    }
    return { ok: priceStatus < 300, status: priceStatus, json: async () => priceBody, text: async () => JSON.stringify(priceBody) };
  };
}

test("GET /quote?amount=... returns the USDC amount, its fiat equivalent, and the quote's age", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const app = createApp(result.db, {
      quoteFetchImpl: makeFetch(200, { buy_amount: "21843.51" }),
    });
    const response = await app.request("/quote?amount=4500000000");
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      amount: string;
      asset: string;
      fiat: { amount: string; currency: string };
      quotedAt: number;
      spreadApplied: boolean;
    };
    assert.equal(body.amount, "4500000000");
    assert.equal(body.asset, "USDC");
    assert.deepEqual(body.fiat, { amount: "21843.51", currency: "TRY" });
    assert.equal(body.spreadApplied, true);
    assert.equal(typeof body.quotedAt, "number");
  } finally {
    closeDatabase(result);
  }
});

test("GET /quote refuses a non-positive-integer amount before any anchor call", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    let called = false;
    const app = createApp(result.db, {
      quoteFetchImpl: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });

    for (const amount of ["0", "-5", "1.5", "abc", ""]) {
      const response = await app.request(amount === "" ? "/quote" : `/quote?amount=${encodeURIComponent(amount)}`);
      assert.equal(response.status, 400, `amount "${amount}"`);
      const body = (await response.json()) as { code: string };
      assert.equal(body.code, "INVALID_AMOUNT");
    }
    assert.equal(called, false);
  } finally {
    closeDatabase(result);
  }
});

test("GET /quote maps an unreachable anchor to 503 QUOTE_UNAVAILABLE, never a raw body", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const app = createApp(result.db, {
      quoteFetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND tr-mock-anchor.fly.dev");
      },
    });
    const response = await app.request("/quote?amount=4500000000");
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string; message: string };
    assert.equal(body.code, "QUOTE_UNAVAILABLE");
    assert.ok(!/ENOTFOUND/.test(body.message));
  } finally {
    closeDatabase(result);
  }
});

test("GET /quote maps an unsupported pair to 409 QUOTE_UNSUPPORTED", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const app = createApp(result.db, {
      quoteFetchImpl: async (url) => {
        if (url.endsWith("/.well-known/stellar.toml")) {
          return { ok: true, status: 200, text: async () => REALISTIC_TOML, json: async () => ({}) };
        }
        // sep38/info never advertises the sell asset -- no fiat pair for it.
        return { ok: true, status: 200, json: async () => ({ assets: [{ asset: "iso4217:TRY" }] }), text: async () => "" };
      },
    });
    const response = await app.request("/quote?amount=4500000000");
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "QUOTE_UNSUPPORTED");
  } finally {
    closeDatabase(result);
  }
});

test("GET /quote served from cache on a second call within the window (no db/auth needed -- a public route)", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    let priceCalls = 0;
    const app = createApp(result.db, {
      quoteFetchImpl: async (url) => {
        if (url.endsWith("/.well-known/stellar.toml")) {
          return { ok: true, status: 200, text: async () => REALISTIC_TOML, json: async () => ({}) };
        }
        if (url.endsWith("/sep38/info")) {
          return { ok: true, status: 200, json: async () => SEP38_INFO_BODY, text: async () => JSON.stringify(SEP38_INFO_BODY) };
        }
        priceCalls += 1;
        return { ok: true, status: 200, json: async () => ({ buy_amount: "21843.51" }), text: async () => "" };
      },
    });
    const first = await app.request("/quote?amount=4500000000");
    const second = await app.request("/quote?amount=4500000000");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstBody = (await first.json()) as { quotedAt: number };
    const secondBody = (await second.json()) as { quotedAt: number };
    assert.equal(secondBody.quotedAt, firstBody.quotedAt);
    assert.equal(priceCalls, 1);
  } finally {
    closeDatabase(result);
  }
});
