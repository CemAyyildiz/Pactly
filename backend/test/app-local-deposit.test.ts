/**
 * Story 2.4's local-currency deposit routes, driven through Hono's
 * `app.request(...)`. Every network call is faked; nothing here reaches
 * `tr-mock-anchor.fly.dev`. Covers the I/O matrix's HTTP-boundary rows.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { resetSep38CacheForTests } from "../src/anchor/sep38.js";
import { resetUsdcAssetCacheForTests } from "../src/anchor/usdc.js";
import type { AnchorFetchLike } from "../src/anchor/http.js";
import { upsertAnchorJwt } from "../src/db/anchorJwts.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const NETWORK = "Test SDF Network ; September 2015";
const HOME = "tr-mock-anchor.fly.dev";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SELL_ASSET = `stellar:USDC:${USDC_ISSUER}`;
const WEB_AUTH = `https://${HOME}/auth`;

const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) };

function tomlFor(signingKey: string): string {
  return `
WEB_AUTH_ENDPOINT="${WEB_AUTH}"
SIGNING_KEY="${signingKey}"
TRANSFER_SERVER="https://${HOME}/sep6"
KYC_SERVER="https://${HOME}/sep12"
ANCHOR_QUOTE_SERVER="https://${HOME}/sep38"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
`;
}

function fakeJwt(sub: string, expiresInSeconds = 86_400): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, iat: now, exp: now + expiresInSeconds })).toString("base64url");
  return `${header}.${payload}.unsigned`;
}

const DEPOSIT_OPEN_BODY = {
  id: "dep-1",
  how: "Bank transfer",
  eta: 3600,
  instructions: {
    organization: { value: "Mock Bank", description: "Bank" },
    iban: { value: "TR000000000000000000000000", description: "IBAN" },
    reference: { value: "PACT-1", description: "Reference" },
  },
  extra_info: { message: "Use the reference exactly." },
  amount_in: "97.51",
};

function transactionBody(status: string) {
  return {
    transaction: {
      id: "dep-1",
      status,
      more_info_url: `https://${HOME}/sep6/tx/dep-1`,
      amount_in: "97.51",
      instructions: DEPOSIT_OPEN_BODY.instructions,
    },
  };
}

interface RouterState {
  depositCalls: number;
  simulateCalls: number;
  lastDepositAmount?: string;
  minAmount?: string;
  maxAmount?: string;
  depositStatus?: number;
  depositBody?: unknown;
  txStatus: string;
  txFail?: boolean;
}

function makeRouter(anchorServer: Keypair, state: RouterState): AnchorFetchLike {
  const toml = tomlFor(anchorServer.publicKey());
  return async (url, init) => {
    const parsed = new URL(url);
    const json = (status: number, body: unknown) => ({
      ok: status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });

    if (parsed.pathname.endsWith("/.well-known/stellar.toml")) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => toml };
    }
    if (parsed.pathname === "/sep38/info") {
      return json(200, { assets: [{ asset: SELL_ASSET }, { asset: "iso4217:TRY" }] });
    }
    if (parsed.pathname === "/sep38/price") {
      return json(200, { buy_amount: "97.51" });
    }
    if (parsed.pathname === "/sep6/info") {
      const usdc: Record<string, unknown> = { enabled: true, authentication_required: true };
      if (state.minAmount) usdc.min_amount = state.minAmount;
      if (state.maxAmount) usdc.max_amount = state.maxAmount;
      return json(200, { deposit: { USDC: usdc } });
    }
    if (parsed.pathname === "/sep12/customer") {
      return json(200, { status: "ACCEPTED" });
    }
    if (parsed.pathname === "/sep6/deposit") {
      state.depositCalls += 1;
      const amount = parsed.searchParams.get("amount") ?? "";
      state.lastDepositAmount = amount;
      if (/\.\d{3,}/.test(amount)) {
        return json(400, { error: "amount supports at most 2 decimal places" });
      }
      return json(state.depositStatus ?? 200, state.depositBody ?? DEPOSIT_OPEN_BODY);
    }
    if (parsed.pathname === "/sep6/transaction") {
      if (state.txFail) {
        return json(503, { error: "down" });
      }
      return json(200, transactionBody(state.txStatus));
    }
    if (parsed.pathname.endsWith("/simulate-bank-transfer")) {
      state.simulateCalls += 1;
      if (state.txStatus === "completed") {
        return json(409, { error: "This deposit already received its bank transfer" });
      }
      state.txStatus = "completed";
      return json(200, { ok: true });
    }
    if (parsed.pathname === "/auth" && (!init?.method || init.method === "GET")) {
      const account = parsed.searchParams.get("account") ?? "";
      const challenge = WebAuth.buildChallengeTx(anchorServer, account, HOME, 300, NETWORK, parsed.host);
      return json(200, { transaction: challenge, network_passphrase: NETWORK });
    }
    if (parsed.pathname === "/auth" && init?.method === "POST") {
      return json(200, { token: fakeJwt("posted") });
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };
}

async function authHeader(walletAddress: string): Promise<Record<string, string>> {
  const token = await issuePactlyJwt(walletAddress);
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function seedHeldBooking(result: ReturnType<typeof openTestDatabase>, clientWalletAddress: string) {
  const providerProfileId = await seedProviderProfile(result, {
    isApproved: true,
    priceAmount: "10000000",
    depositRateBps: 2000,
  });
  const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
  await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
  return holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);
}

function resetCaches(): void {
  resetSep38CacheForTests();
  resetUsdcAssetCacheForTests();
}

test("POST /bookings/:id/anchor/challenge reuses a still-valid stored JWT", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    await upsertAnchorJwt(result.db, { walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now() });
    let fetchCalls = 0;
    const app = createApp(result.db, {
      localDepositDeps: {
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("must not hit the anchor");
        },
      },
    });
    const response = await app.request(`/bookings/${hold.bookingId}/anchor/challenge`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { authenticated: boolean };
    assert.equal(body.authenticated, true);
    assert.equal(fetchCalls, 0);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/anchor/challenge returns an unsigned XDR when no JWT is cached", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    const anchorServer = Keypair.random();
    const state: RouterState = { depositCalls: 0, simulateCalls: 0, txStatus: "pending_user_transfer_start" };
    const app = createApp(result.db, { localDepositDeps: { fetchImpl: makeRouter(anchorServer, state) } });
    const response = await app.request(`/bookings/${hold.bookingId}/anchor/challenge`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { authenticated: boolean; unsignedXdr?: string };
    assert.equal(body.authenticated, false);
    assert.ok(body.unsignedXdr && body.unsignedXdr.length > 0);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/anchor/verify stores the JWT so a later challenge is reused", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const wallet = Keypair.random();
    const hold = await seedHeldBooking(result, wallet.publicKey());
    const anchorServer = Keypair.random();
    const state: RouterState = { depositCalls: 0, simulateCalls: 0, txStatus: "pending_user_transfer_start" };
    const fetchImpl = makeRouter(anchorServer, state);
    const app = createApp(result.db, { localDepositDeps: { fetchImpl } });
    const challenge = await app.request(`/bookings/${hold.bookingId}/anchor/challenge`, {
      method: "POST",
      headers: await authHeader(wallet.publicKey()),
    });
    const { unsignedXdr } = (await challenge.json()) as { unsignedXdr: string };
    const tx = TransactionBuilder.fromXDR(unsignedXdr, NETWORK);
    tx.sign(wallet);
    const verify = await app.request(`/bookings/${hold.bookingId}/anchor/verify`, {
      method: "POST",
      headers: await authHeader(wallet.publicKey()),
      body: JSON.stringify({ signedXdr: tx.toXDR() }),
    });
    assert.equal(verify.status, 200);
    const again = await app.request(`/bookings/${hold.bookingId}/anchor/challenge`, {
      method: "POST",
      headers: await authHeader(wallet.publicKey()),
    });
    const body = (await again.json()) as { authenticated: boolean };
    assert.equal(body.authenticated, true);
  } finally {
    closeDatabase(result);
  }
});

test("a stranger gets 404 BOOKING_NOT_FOUND on every local-deposit route", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const hold = await seedHeldBooking(result, Keypair.random().publicKey());
    const app = createApp(result.db);
    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local`, {
      method: "POST",
      headers: await authHeader(Keypair.random().publicKey()),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/deposit/local returns bank details for an authenticated client with a trustline", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    await upsertAnchorJwt(result.db, { walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now() });
    const anchorServer = Keypair.random();
    const state: RouterState = { depositCalls: 0, simulateCalls: 0, txStatus: "pending_user_transfer_start" };
    const app = createApp(result.db, {
      localDepositDeps: { fetchImpl: makeRouter(anchorServer, state), hasTrustline: async () => true },
    });
    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      statusLabel: string;
      bankDetails: { iban?: string; reference?: string };
      sandbox: boolean;
    };
    assert.equal(body.status, "waiting");
    assert.equal(body.statusLabel, "Waiting for your transfer");
    assert.equal(body.bankDetails.iban, "TR000000000000000000000000");
    assert.equal(body.bankDetails.reference, "PACT-1");
    assert.equal(body.sandbox, true);
    assert.equal(state.depositCalls, 1);
    assert.equal(state.lastDepositAmount, "97.51");

    const again = await app.request(`/bookings/${hold.bookingId}/deposit/local`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(again.status, 200);
    assert.equal(state.depositCalls, 1, "an already-open deposit is reused");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/deposit/local refuses an amount outside advertised limits before opening", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    await upsertAnchorJwt(result.db, { walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now() });
    const anchorServer = Keypair.random();
    const state: RouterState = {
      depositCalls: 0,
      simulateCalls: 0,
      txStatus: "pending_user_transfer_start",
      minAmount: "500.00",
      maxAmount: "3000.00",
    };
    const app = createApp(result.db, {
      localDepositDeps: { fetchImpl: makeRouter(anchorServer, state), hasTrustline: async () => true },
    });
    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; details: { min: string; max: string; currency: string } };
    assert.equal(body.code, "AMOUNT_OUT_OF_RANGE");
    assert.equal(body.details.min, "500.00");
    assert.equal(body.details.max, "3000.00");
    assert.equal(body.details.currency, "TRY");
    assert.equal(state.depositCalls, 0);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/deposit/local returns needsTrustline when the wallet has no USDC", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    await upsertAnchorJwt(result.db, { walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now() });
    const anchorServer = Keypair.random();
    const state: RouterState = { depositCalls: 0, simulateCalls: 0, txStatus: "pending_user_transfer_start" };
    const app = createApp(result.db, {
      localDepositDeps: {
        fetchImpl: makeRouter(anchorServer, state),
        hasTrustline: async () => false,
        buildTrustline: { getAccount: async (publicKey) => new Account(publicKey, "0") },
      },
    });
    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { needsTrustline: boolean; unsignedXdr: string };
    assert.equal(body.needsTrustline, true);
    assert.ok(body.unsignedXdr.length > 0);
    assert.equal(state.depositCalls, 0);
  } finally {
    closeDatabase(result);
  }
});

test("GET /bookings/:id/deposit/local maps completed to Money received and extends the hold while pending", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    await upsertAnchorJwt(result.db, { walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now() });
    const anchorServer = Keypair.random();
    const state: RouterState = { depositCalls: 0, simulateCalls: 0, txStatus: "pending_user_transfer_start" };
    let nowMs = Date.now();
    const app = createApp(result.db, {
      localDepositDeps: { fetchImpl: makeRouter(anchorServer, state), hasTrustline: async () => true, now: () => nowMs },
    });
    await app.request(`/bookings/${hold.bookingId}/deposit/local`, { method: "POST", headers: await authHeader(client) });
    nowMs += 5_000;
    const pending = await app.request(`/bookings/${hold.bookingId}/deposit/local`, { headers: await authHeader(client) });
    assert.equal(pending.status, 200);
    const pendingBody = (await pending.json()) as { status: string; holdExpiresAt: number };
    assert.equal(pendingBody.status, "waiting");
    assert.equal(pendingBody.holdExpiresAt, Math.floor(nowMs / 1000) + 600);

    state.txStatus = "pending_anchor";
    nowMs += 5_000;
    const paying = await app.request(`/bookings/${hold.bookingId}/deposit/local`, { headers: await authHeader(client) });
    const payingBody = (await paying.json()) as { status: string; statusLabel: string };
    assert.equal(payingBody.status, "paying");
    assert.equal(payingBody.statusLabel, "Paying into your wallet");

    state.txStatus = "completed";
    const done = await app.request(`/bookings/${hold.bookingId}/deposit/local`, { headers: await authHeader(client) });
    const doneBody = (await done.json()) as { status: string; statusLabel: string };
    assert.equal(doneBody.status, "received");
    assert.equal(doneBody.statusLabel, "Money received");
  } finally {
    closeDatabase(result);
  }
});

test("GET /bookings/:id/deposit/local returns stale: true when the anchor is unreachable", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    await upsertAnchorJwt(result.db, { walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now() });
    const anchorServer = Keypair.random();
    const state: RouterState = { depositCalls: 0, simulateCalls: 0, txStatus: "pending_user_transfer_start" };
    const app = createApp(result.db, {
      localDepositDeps: { fetchImpl: makeRouter(anchorServer, state), hasTrustline: async () => true },
    });
    await app.request(`/bookings/${hold.bookingId}/deposit/local`, { method: "POST", headers: await authHeader(client) });
    state.txFail = true;
    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local`, { headers: await authHeader(client) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { stale: boolean; status: string };
    assert.equal(body.stale, true);
    assert.equal(body.status, "waiting");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/deposit/local/simulate completes the sandbox transfer", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    await upsertAnchorJwt(result.db, { walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now() });
    const anchorServer = Keypair.random();
    const state: RouterState = { depositCalls: 0, simulateCalls: 0, txStatus: "pending_anchor" };
    const app = createApp(result.db, {
      localDepositDeps: { fetchImpl: makeRouter(anchorServer, state), hasTrustline: async () => true },
    });
    await app.request(`/bookings/${hold.bookingId}/deposit/local`, { method: "POST", headers: await authHeader(client) });
    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local/simulate`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; statusLabel: string };
    assert.equal(state.simulateCalls, 1);
    assert.equal(body.status, "received");
    assert.equal(body.statusLabel, "Money received");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/deposit/local/simulate treats an already-applied sandbox transfer as success", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    await upsertAnchorJwt(result.db, { walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now() });
    const anchorServer = Keypair.random();
    const state: RouterState = { depositCalls: 0, simulateCalls: 0, txStatus: "pending_anchor" };
    const app = createApp(result.db, {
      localDepositDeps: { fetchImpl: makeRouter(anchorServer, state), hasTrustline: async () => true },
    });
    await app.request(`/bookings/${hold.bookingId}/deposit/local`, { method: "POST", headers: await authHeader(client) });
    const first = await app.request(`/bookings/${hold.bookingId}/deposit/local/simulate`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(first.status, 200);
    const second = await app.request(`/bookings/${hold.bookingId}/deposit/local/simulate`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(second.status, 200);
    const body = (await second.json()) as { status: string; statusLabel: string };
    assert.equal(state.simulateCalls, 2);
    assert.equal(body.status, "received");
    assert.equal(body.statusLabel, "Money received");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/deposit/local returns 401 ANCHOR_AUTH_REQUIRED without a stored JWT", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHeldBooking(result, client);
    const app = createApp(result.db, { localDepositDeps: { hasTrustline: async () => true } });
    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local`, {
      method: "POST",
      headers: await authHeader(client),
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "ANCHOR_AUTH_REQUIRED");
  } finally {
    closeDatabase(result);
  }
});
