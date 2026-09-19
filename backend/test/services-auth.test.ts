/**
 * `services/auth.ts`'s `getOrRefreshAnchorJwt` exercised as a unit, over a
 * real temporary SQLite database (`openDatabase(":memory:")`), with the
 * anchor's `stellar.toml` fetch and its SEP-10 exchange both injected --
 * never a real network call, never a real anchor round trip. Covers the
 * I/O matrix's "Anchor JWT reused" and "Anchor JWT expired, refetched" rows
 * end to end, plus the defensive signer/wallet check.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, WebAuth } from "@stellar/stellar-sdk";

import { getOrRefreshAnchorJwt } from "../src/services/auth.js";
import { getAnchorJwt, upsertAnchorJwt } from "../src/db/anchorJwts.js";
import { config } from "../src/config.js";
import type { FetchLike } from "../src/anchor/stellar-toml.js";
import type { Sep10FetchLike } from "../src/anchor/sep10.js";
import { closeDatabase, openTestDatabase } from "./helpers.js";

const WEB_AUTH_ENDPOINT = `https://${config.anchorHomeDomain}/auth`;

function fakeAnchorJwt(sub: string, expiresInSeconds = 86_400): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, iat: nowSeconds, exp: nowSeconds + expiresInSeconds })).toString(
    "base64url",
  );
  return `${header}.${payload}.unsigned`;
}

/** A wallet, an anchor server keypair, and the two fetch seams that make a
 * full, fake-but-real-shaped anchor SEP-10 exchange succeed for that
 * wallet. */
function anchorFixture(wallet: Keypair) {
  const anchorServer = Keypair.random();
  const token = fakeAnchorJwt(wallet.publicKey());

  const tomlFetch: FetchLike = async (url) => {
    assert.equal(url, `https://${config.anchorHomeDomain}/.well-known/stellar.toml`);
    return {
      ok: true,
      status: 200,
      text: async () => `WEB_AUTH_ENDPOINT="${WEB_AUTH_ENDPOINT}"\nSIGNING_KEY="${anchorServer.publicKey()}"\n`,
    };
  };

  const sep10Fetch: Sep10FetchLike = async (_url, init) => {
    if (!init || init.method === "GET" || init.method === undefined) {
      const challengeXdr = WebAuth.buildChallengeTx(
        anchorServer,
        wallet.publicKey(),
        config.anchorHomeDomain,
        300,
        config.stellarNetworkPassphrase,
        config.anchorHomeDomain,
      );
      return { ok: true, status: 200, json: async () => ({ transaction: challengeXdr }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({ token }), text: async () => "" };
  };

  return { anchorServer, token, tomlFetch, sep10Fetch };
}

function unreachable(): never {
  throw new Error("must not have been called");
}

test("no cached anchor JWT: runs the anchor's real SEP-10 exchange (through injected seams) and caches the result", async () => {
  const result = openTestDatabase();
  try {
    const wallet = Keypair.random();
    const { token, tomlFetch, sep10Fetch } = anchorFixture(wallet);

    const jwt = await getOrRefreshAnchorJwt(result.db, wallet.publicKey(), wallet, { tomlFetch, sep10Fetch });
    assert.equal(jwt, token);

    const cached = await getAnchorJwt(result.db, wallet.publicKey());
    assert.equal(cached?.jwt, token);
  } finally {
    closeDatabase(result);
  }
});

test("a still-valid cached anchor JWT is reused: no stellar.toml fetch, no anchor round trip", async () => {
  const result = openTestDatabase();
  try {
    const wallet = Keypair.random();
    await upsertAnchorJwt(result.db, { walletAddress: wallet.publicKey(), jwt: "cached-jwt", expiresAt: Date.now() + 100_000 });

    const jwt = await getOrRefreshAnchorJwt(result.db, wallet.publicKey(), wallet, {
      tomlFetch: async () => unreachable(),
      sep10Fetch: async () => unreachable(),
    });
    assert.equal(jwt, "cached-jwt");
  } finally {
    closeDatabase(result);
  }
});

test("an expired cached anchor JWT triggers a fresh exchange and replaces the cached row", async () => {
  const result = openTestDatabase();
  try {
    const wallet = Keypair.random();
    const { token, tomlFetch, sep10Fetch } = anchorFixture(wallet);
    await upsertAnchorJwt(result.db, { walletAddress: wallet.publicKey(), jwt: "stale-jwt", expiresAt: Date.now() - 1_000 });

    const jwt = await getOrRefreshAnchorJwt(result.db, wallet.publicKey(), wallet, { tomlFetch, sep10Fetch });
    assert.equal(jwt, token);
    assert.notEqual(jwt, "stale-jwt");

    const cached = await getAnchorJwt(result.db, wallet.publicKey());
    assert.equal(cached?.jwt, token);
  } finally {
    closeDatabase(result);
  }
});

test("a cached JWT expiring exactly now is treated as expired (not reused)", async () => {
  const result = openTestDatabase();
  try {
    const wallet = Keypair.random();
    const { token, tomlFetch, sep10Fetch } = anchorFixture(wallet);
    const now = 1_000_000;
    await upsertAnchorJwt(result.db, { walletAddress: wallet.publicKey(), jwt: "boundary-jwt", expiresAt: now });

    const jwt = await getOrRefreshAnchorJwt(result.db, wallet.publicKey(), wallet, { tomlFetch, sep10Fetch, now: () => now });
    assert.equal(jwt, token);
  } finally {
    closeDatabase(result);
  }
});

test("a signer that does not match walletAddress is refused before any network access", async () => {
  const result = openTestDatabase();
  try {
    const wallet = Keypair.random();
    const otherSigner = Keypair.random();
    await assert.rejects(
      () =>
        getOrRefreshAnchorJwt(result.db, wallet.publicKey(), otherSigner, {
          tomlFetch: async () => unreachable(),
          sep10Fetch: async () => unreachable(),
        }),
      TypeError,
    );
  } finally {
    closeDatabase(result);
  }
});
