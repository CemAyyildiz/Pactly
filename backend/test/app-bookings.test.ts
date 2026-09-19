/**
 * Story 3.4's five booking routes (`POST /bookings/hold`,
 * `POST /bookings/:id/lock`, `POST /bookings/:id/fund`,
 * `POST /bookings/:id/submit`, `GET /bookings/:id`), driven through Hono's
 * own `app.request(...)` like `app-providers.test.ts`. Covers the I/O
 * matrix's status codes and envelope shapes at the HTTP boundary; the
 * escrow-adapter-level behavior (deploy/fund/submit payload wiring, XDR
 * retry/rebuild) is `services-booking.test.ts`/`services-booking-hold.
 * test.ts`'s job. `TRUSTLESS_WORK_*` is empty in the test fixture env
 * (`testConfigEnv.ts`), so any route that would reach the adapter refuses
 * before any network access with a typed `EscrowConfigError` -- exercised
 * here as the route's own `503 ESCROW_UNAVAILABLE` mapping.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) };

async function authHeader(walletAddress: string): Promise<Record<string, string>> {
  const token = await issuePactlyJwt(walletAddress);
  return { authorization: `Bearer ${token}` };
}

test("POST /bookings/hold returns 201 with amounts derived from the provider, never from the caller", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, {
      isApproved: true,
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
    });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const app = createApp(result.db);
    const headers = { ...(await authHeader("GCLIENTWALLET1")), "content-type": "application/json" };

    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: providerProfileId, slotStartsAt }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { bookingId: string; deposit: { amount: string; asset: string } };
    assert.equal(body.deposit.amount, "2000000");
    assert.equal(body.deposit.asset, "USDC");
    assert.ok(body.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/hold gives 404 PROVIDER_NOT_FOUND for an unapproved provider", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: false });
    const app = createApp(result.db);
    const headers = { ...(await authHeader("GCLIENTWALLET2")), "content-type": "application/json" };
    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: providerProfileId, slotStartsAt: Math.floor(Date.now() / 1000) + 3600 }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "PROVIDER_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/hold gives 409 SLOT_TAKEN with the day's other open slots once a slot is already held", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const slotStartsAt = now + 3600;
    const otherSlot = now + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt, otherSlot]);
    await holdSlot(result.db, { providerProfileId, clientWalletAddress: "GFIRSTCLIENT", slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = { ...(await authHeader("GSECONDCLIENT")), "content-type": "application/json" };
    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: providerProfileId, slotStartsAt }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; details: { sameDaySlots: number[] } };
    assert.equal(body.code, "SLOT_TAKEN");
    assert.deepEqual(body.details.sameDaySlots, [otherSlot]);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/hold gives 401 with no token", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "x", slotStartsAt: 1 }),
    });
    assert.equal(response.status, 401);
  } finally {
    closeDatabase(result);
  }
});

test("GET /bookings/:id returns the owner's own booking view", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, priceAmount: "10000000", depositRateBps: 2000 });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = await authHeader(clientWalletAddress);
    const response = await app.request(`/bookings/${hold.bookingId}`, { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { id: string; escrowState: string | null };
    assert.equal(body.id, hold.bookingId);
    assert.equal(body.escrowState, null);
  } finally {
    closeDatabase(result);
  }
});

test("GET /bookings/:id gives 404 BOOKING_NOT_FOUND for someone else's booking, indistinguishable from an unknown id", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress: "GOWNERWALLET2", slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const strangerHeaders = await authHeader("GSTRANGERWALLET");
    const responseForOthersBooking = await app.request(`/bookings/${hold.bookingId}`, { headers: strangerHeaders });
    assert.equal(responseForOthersBooking.status, 404);
    const bodyForOthersBooking = (await responseForOthersBooking.json()) as { code: string };
    assert.equal(bodyForOthersBooking.code, "BOOKING_NOT_FOUND");

    const responseForUnknown = await app.request("/bookings/does-not-exist", { headers: strangerHeaders });
    assert.equal(responseForUnknown.status, 404);
    const bodyForUnknown = (await responseForUnknown.json()) as { code: string };
    assert.equal(bodyForUnknown.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/lock gives 404 BOOKING_NOT_FOUND for someone else's booking, before ever reaching the adapter", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress: "GOWNERWALLET3", slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const strangerHeaders = { ...(await authHeader("GSTRANGERWALLET2")), "content-type": "application/json" };
    const response = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers: strangerHeaders });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/lock gives 503 ESCROW_UNAVAILABLE when the owner calls it but Trustless Work is unconfigured", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET4";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const response = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "ESCROW_UNAVAILABLE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/fund gives 409 BOOKING_STATE when no contractId has been persisted yet", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET5";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const response = await app.request(`/bookings/${hold.bookingId}/fund`, { method: "POST", headers });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/submit gives 400 for a missing signedXdr, and 404 for someone else's booking", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET6";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const ownerHeaders = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const missingXdrResponse = await app.request(`/bookings/${hold.bookingId}/submit`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(missingXdrResponse.status, 400);

    const strangerHeaders = { ...(await authHeader("GSTRANGERWALLET3")), "content-type": "application/json" };
    const strangerResponse = await app.request(`/bookings/${hold.bookingId}/submit`, {
      method: "POST",
      headers: strangerHeaders,
      body: JSON.stringify({ signedXdr: "irrelevant" }),
    });
    assert.equal(strangerResponse.status, 404);
    const strangerBody = (await strangerResponse.json()) as { code: string };
    assert.equal(strangerBody.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});
