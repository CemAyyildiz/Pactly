/**
 * Story 3.7's three balance routes (`POST /bookings/:id/balance/pay`,
 * `POST /bookings/:id/balance/submit`, `POST /bookings/:id/balance/
 * mark-cash`), driven through Hono's own `app.request(...)` -- same pattern
 * as `app-bookings.test.ts`/`app-booking-actions.test.ts`. Covers the I/O
 * matrix's own status codes and envelope shapes at the HTTP boundary, plus
 * that `GET /bookings/:id` and `GET /me/bookings` both carry `balanceState`
 * and the payment tx hash once paid (the spec's own "Lists" row).
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, rpc } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { updateEscrowContractId, updateEscrowState } from "../src/db/bookings.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC = { code: "USDC", issuer: Keypair.random().publicKey(), contractId: "CUSDCFAKE00000000000000000000000000000000000000000" };
const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => FAKE_USDC };
const getAccountStub = async (publicKey: string) => new Account(publicKey, "0");

async function authHeader(walletAddress: string): Promise<Record<string, string>> {
  const token = await issuePactlyJwt(walletAddress);
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** Seeds a provider, a future slot, and a locked booking on it (mirrors
 * `app-me-bookings.test.ts`'s own shape: `holdSlot` for the real hold, then
 * `updateEscrowContractId`/`updateEscrowState` directly -- there is no
 * route that reaches a real Trustless Work API key in this test
 * environment). */
async function seedLockedBooking(
  result: Awaited<ReturnType<typeof openTestDatabase>>,
  options: { clientWalletAddress?: string; providerWalletAddress?: string; depositRateBps?: number } = {},
): Promise<{ bookingId: string; clientWalletAddress: string; providerWalletAddress: string }> {
  const clientWalletAddress = options.clientWalletAddress ?? Keypair.random().publicKey();
  const providerWalletAddress = options.providerWalletAddress ?? Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, {
    isApproved: true,
    walletAddress: providerWalletAddress,
    priceAmount: "10000000",
    depositRateBps: options.depositRateBps ?? 2000,
  });
  const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
  await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
  const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);
  await updateEscrowContractId(result.db, hold.bookingId, "CFAKECONTRACT0000000000000000000000000000000000000");
  await updateEscrowState(result.db, hold.bookingId, "locked");
  return { bookingId: hold.bookingId, clientWalletAddress, providerWalletAddress };
}

test("POST /bookings/:id/balance/pay returns 200 with an unsigned XDR for the booking's own client", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db, { buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub } });
    const response = await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers: await authHeader(clientWalletAddress) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { unsignedXdr: string };
    assert.ok(body.unsignedXdr.length > 0);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/pay gives 404 for a wallet that is not this booking's client", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await seedLockedBooking(result);
    const app = createApp(result.db, { buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub } });
    const response = await app.request(`/bookings/${bookingId}/balance/pay`, {
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

test("POST /bookings/:id/balance/pay gives 409 NOTHING_TO_PAY for a zero balance", async () => {
  const result = openTestDatabase();
  try {
    // A 100% deposit rate leaves a "0" balance (price - deposit).
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result, { depositRateBps: 10000 });
    const app = createApp(result.db, { buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub } });
    const response = await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers: await authHeader(clientWalletAddress) });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "NOTHING_TO_PAY");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/pay gives 409 BOOKING_STATE when the booking is not locked", async () => {
  const result = openTestDatabase();
  try {
    const clientWalletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);
    // Never locked -- escrowState stays null.
    const app = createApp(result.db, { buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub } });
    const response = await app.request(`/bookings/${hold.bookingId}/balance/pay`, { method: "POST", headers: await authHeader(clientWalletAddress) });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/submit gives 409 XDR_MISMATCH for a signed envelope that was never built for this booking's balance", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db, { buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub } });
    const headers = await authHeader(clientWalletAddress);
    // A built hash must exist for `submit` to reach its own hash-match
    // check at all (otherwise it refuses `BOOKING_STATE` first, per the
    // review follow-up: "and a built hash exists").
    await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers });
    const response = await app.request(`/bookings/${bookingId}/balance/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedXdr: "not-a-real-envelope" }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "XDR_MISMATCH");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/submit confirms paid_platform, and both GET /bookings/:id and GET /me/bookings carry the tx hash", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db, {
      buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub },
      submitBalancePaymentDeps: {
        sendTransaction: async () => ({ status: "PENDING", hash: "cafef00d" }) as rpc.Api.SendTransactionResponse,
        waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as rpc.Api.GetTransactionResponse,
      },
    });
    const headers = await authHeader(clientWalletAddress);

    const payResponse = await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers });
    const { unsignedXdr } = (await payResponse.json()) as { unsignedXdr: string };

    const submitResponse = await app.request(`/bookings/${bookingId}/balance/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedXdr: unsignedXdr }),
    });
    assert.equal(submitResponse.status, 200);
    const submitBody = (await submitResponse.json()) as { txHash: string };
    assert.equal(submitBody.txHash, "cafef00d");

    const viewResponse = await app.request(`/bookings/${bookingId}`, { headers });
    const view = (await viewResponse.json()) as { balancePaymentTxHash: string | null };
    assert.equal(view.balancePaymentTxHash, "cafef00d");

    const listResponse = await app.request("/me/bookings", { headers });
    const listBody = (await listResponse.json()) as { bookings: Array<{ id: string; balanceState: string; balancePaymentTxHash: string | null }> };
    const item = listBody.bookings.find((b) => b.id === bookingId);
    assert.equal(item?.balanceState, "paid_platform");
    assert.equal(item?.balancePaymentTxHash, "cafef00d");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/submit's confirmed payment also shows up on GET /me/provider/bookings", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress, providerWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db, {
      buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub },
      submitBalancePaymentDeps: {
        sendTransaction: async () => ({ status: "PENDING", hash: "providerbeef" }) as rpc.Api.SendTransactionResponse,
        waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as rpc.Api.GetTransactionResponse,
      },
    });
    const clientHeaders = await authHeader(clientWalletAddress);
    const payResponse = await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers: clientHeaders });
    const { unsignedXdr } = (await payResponse.json()) as { unsignedXdr: string };
    await app.request(`/bookings/${bookingId}/balance/submit`, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ signedXdr: unsignedXdr }),
    });

    const providerListResponse = await app.request("/me/provider/bookings", { headers: await authHeader(providerWalletAddress) });
    const body = (await providerListResponse.json()) as {
      bookings: Array<{ id: string; balanceState: string; balancePaymentTxHash: string | null }>;
    };
    const item = body.bookings.find((b) => b.id === bookingId);
    assert.equal(item?.balanceState, "paid_platform");
    assert.equal(item?.balancePaymentTxHash, "providerbeef");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/pay gives 503 PAYMENT_UNAVAILABLE when resolving the USDC asset fails", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db, {
      buildBalancePaymentDeps: {
        resolveUsdcAsset: async () => {
          throw new Error("anchor unreachable");
        },
        getAccount: getAccountStub,
      },
    });
    const response = await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers: await authHeader(clientWalletAddress) });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "PAYMENT_UNAVAILABLE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/pay gives 503 PAYMENT_UNAVAILABLE when loading the client's account fails", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db, {
      buildBalancePaymentDeps: {
        resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset,
        getAccount: async () => {
          throw new Error("RPC unreachable");
        },
      },
    });
    const response = await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers: await authHeader(clientWalletAddress) });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "PAYMENT_UNAVAILABLE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/submit gives 400 when signedXdr is missing", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db);
    const response = await app.request(`/bookings/${bookingId}/balance/submit`, {
      method: "POST",
      headers: await authHeader(clientWalletAddress),
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "invalid_request");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/submit gives 404 for an unknown booking id", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await app.request(`/bookings/${"0".repeat(32)}/balance/submit`, {
      method: "POST",
      headers: await authHeader(Keypair.random().publicKey()),
      body: JSON.stringify({ signedXdr: "anything" }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/mark-cash gives 404 for an unknown booking id", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await app.request(`/bookings/${"0".repeat(32)}/balance/mark-cash`, {
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

test("POST /bookings/:id/balance/submit gives 502 PAYMENT_FAILED once the ledger reports FAILED", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db, {
      buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub },
      submitBalancePaymentDeps: {
        sendTransaction: async () => ({ status: "PENDING", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
        waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.FAILED }) as rpc.Api.GetTransactionResponse,
      },
    });
    const headers = await authHeader(clientWalletAddress);
    const payResponse = await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers });
    const { unsignedXdr } = (await payResponse.json()) as { unsignedXdr: string };

    const submitResponse = await app.request(`/bookings/${bookingId}/balance/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedXdr: unsignedXdr }),
    });
    assert.equal(submitResponse.status, 502);
    const body = (await submitResponse.json()) as { code: string };
    assert.equal(body.code, "PAYMENT_FAILED");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/submit gives 503 PAYMENT_UNAVAILABLE when the RPC endpoint is unreachable", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db, {
      buildBalancePaymentDeps: { resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset, getAccount: getAccountStub },
      submitBalancePaymentDeps: {
        sendTransaction: async () => {
          throw new Error("network unreachable");
        },
      },
    });
    const headers = await authHeader(clientWalletAddress);
    const payResponse = await app.request(`/bookings/${bookingId}/balance/pay`, { method: "POST", headers });
    const { unsignedXdr } = (await payResponse.json()) as { unsignedXdr: string };

    const submitResponse = await app.request(`/bookings/${bookingId}/balance/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedXdr: unsignedXdr }),
    });
    assert.equal(submitResponse.status, 503);
    const body = (await submitResponse.json()) as { code: string };
    assert.equal(body.code, "PAYMENT_UNAVAILABLE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/mark-cash writes paid_cash for the booking's own provider", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db);
    const response = await app.request(`/bookings/${bookingId}/balance/mark-cash`, {
      method: "POST",
      headers: await authHeader(providerWalletAddress),
    });
    assert.equal(response.status, 200);

    const providerListResponse = await app.request("/me/provider/bookings", { headers: await authHeader(providerWalletAddress) });
    const body = (await providerListResponse.json()) as { bookings: Array<{ id: string; balanceState: string }> };
    const item = body.bookings.find((b) => b.id === bookingId);
    assert.equal(item?.balanceState, "paid_cash");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/mark-cash gives 404 when the client calls it", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db);
    const response = await app.request(`/bookings/${bookingId}/balance/mark-cash`, {
      method: "POST",
      headers: await authHeader(clientWalletAddress),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/balance/mark-cash gives 409 once the balance is already paid", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seedLockedBooking(result);
    const app = createApp(result.db);
    const headers = await authHeader(providerWalletAddress);
    await app.request(`/bookings/${bookingId}/balance/mark-cash`, { method: "POST", headers });
    const response = await app.request(`/bookings/${bookingId}/balance/mark-cash`, { method: "POST", headers });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});
