/**
 * Story 3.6's own routes (`POST /bookings/:id/{complete,approve,release,
 * dispute}`, `POST /admin/bookings/:id/resolve`, `GET /admin/disputes`),
 * driven through Hono's own `app.request(...)` like `app-bookings.test.ts`.
 * Covers the I/O matrix's status codes and envelope shapes at the HTTP
 * boundary -- the service-level behavior (role/state guards, the
 * suggested-outcome policy, the hash-matching submit rule) is
 * `services-booking-actions.test.ts`'s job.
 */
import "./testConfigEnvAdmin.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { getBookingById, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";
import { DISPUTE_RESOLVER_ADMIN_WALLET, NON_RESOLVER_ADMIN_WALLET } from "./testConfigEnvAdmin.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

async function authHeader(walletAddress: string): Promise<Record<string, string>> {
  const token = await issuePactlyJwt(walletAddress);
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** An `EscrowAdapter` every method of which throws unless overridden --
 * mirrors `app-bookings.test.ts`'s own `fakeEscrowAdapter`. */
function fakeEscrowAdapter(overrides: Partial<EscrowAdapter> = {}): EscrowAdapter {
  const unimplemented = (name: string) => () => {
    throw new Error(`${name} should not have been called in this test`);
  };
  return {
    deploy: overrides.deploy ?? unimplemented("deploy"),
    fund: overrides.fund ?? unimplemented("fund"),
    complete: overrides.complete ?? unimplemented("complete"),
    approve: overrides.approve ?? unimplemented("approve"),
    release: overrides.release ?? unimplemented("release"),
    startDispute: overrides.startDispute ?? unimplemented("startDispute"),
    resolveDispute: overrides.resolveDispute ?? unimplemented("resolveDispute"),
    submit: overrides.submit ?? unimplemented("submit"),
  };
}

/** Seeds a locked booking with a persisted contractId at a given point in
 * its recorded lifecycle -- the HTTP-layer sibling of
 * `services-booking-actions.test.ts`'s own `seedLockedBooking`, built
 * directly against the db layer rather than through the hold/lock/fund
 * routes (same discipline `app-bookings.test.ts` already uses for its own
 * hold-expiry tests). */
async function seedLockedBooking(
  result: Awaited<ReturnType<typeof openTestDatabase>>,
  options: { clientWalletAddress?: string; providerWalletAddress?: string; lifecycleAction?: "funded" | "completed" | "approved" | "disputed" } = {},
): Promise<{ bookingId: string; contractId: string; clientWalletAddress: string; providerWalletAddress: string }> {
  const clientWalletAddress = options.clientWalletAddress ?? Keypair.random().publicKey();
  const providerWalletAddress = options.providerWalletAddress ?? Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
  const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress });
  const contractId = fakeContractId();
  await updateEscrowContractId(result.db, bookingId, contractId);
  updateEscrowStateSync(result.db, bookingId, "locked");
  const action = options.lifecycleAction ?? "funded";
  await insertEscrowProcessedEventIfNew(result.db, {
    bookingId,
    contractId,
    lifecycleAction: action,
    amount: "1000000",
    ledgerSeq: "1",
    isAnomaly: false,
    processedAt: Date.now(),
  });
  return { bookingId, contractId, clientWalletAddress, providerWalletAddress };
}

// ---------------------------------------------------------------------------
// POST /bookings/:id/complete
// ---------------------------------------------------------------------------

test("POST /bookings/:id/complete: 200 for the provider, 404 for the client", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const adapter = fakeEscrowAdapter({ complete: async () => ({ unsignedXdr: "x", txHash: "complete-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });

    const providerResponse = await app.request(`/bookings/${seed.bookingId}/complete`, {
      method: "POST",
      headers: await authHeader(seed.providerWalletAddress),
    });
    assert.equal(providerResponse.status, 200);
    assert.equal(((await providerResponse.json()) as { txHash: string }).txHash, "complete-tx-hash");

    const clientResponse = await app.request(`/bookings/${seed.bookingId}/complete`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
    });
    assert.equal(clientResponse.status, 404);
    assert.equal(((await clientResponse.json()) as { code: string }).code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/complete: 409 BOOKING_STATE once already completed", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "completed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/complete`, {
      method: "POST",
      headers: await authHeader(seed.providerWalletAddress),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/approve
// ---------------------------------------------------------------------------

test("POST /bookings/:id/approve: 200 for the client, 404 for the provider", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "completed" });
    const adapter = fakeEscrowAdapter({ approve: async () => ({ unsignedXdr: "x", txHash: "approve-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });

    const clientResponse = await app.request(`/bookings/${seed.bookingId}/approve`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
    });
    assert.equal(clientResponse.status, 200);

    const providerResponse = await app.request(`/bookings/${seed.bookingId}/approve`, {
      method: "POST",
      headers: await authHeader(seed.providerWalletAddress),
    });
    assert.equal(providerResponse.status, 404);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/release
// ---------------------------------------------------------------------------

test("POST /bookings/:id/release: 200 for the provider once approved; 409 before that", async () => {
  const result = openTestDatabase();
  try {
    const funded = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const tooEarly = await app.request(`/bookings/${funded.bookingId}/release`, {
      method: "POST",
      headers: await authHeader(funded.providerWalletAddress),
    });
    assert.equal(tooEarly.status, 409);

    const approved = await seedLockedBooking(result, { lifecycleAction: "approved" });
    const adapter = fakeEscrowAdapter({ release: async () => ({ unsignedXdr: "x", txHash: "release-tx-hash" }) });
    const app2 = createApp(result.db, { escrowAdapter: adapter });
    const ok = await app2.request(`/bookings/${approved.bookingId}/release`, {
      method: "POST",
      headers: await authHeader(approved.providerWalletAddress),
    });
    assert.equal(ok.status, 200);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/dispute
// ---------------------------------------------------------------------------

test("POST /bookings/:id/dispute: 400 for an unknown reason, before ever reaching the service", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "not-a-real-reason" }),
    });
    assert.equal(response.status, 400);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 200 for the client with a known reason, carrying the suggested outcome", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const adapter = fakeEscrowAdapter({ startDispute: async () => ({ unsignedXdr: "x", txHash: "dispute-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "no-show" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { txHash: string; reason: string; suggestedOutcome?: string };
    assert.equal(body.txHash, "dispute-tx-hash");
    assert.equal(body.reason, "no-show");
    assert.equal(body.suggestedOutcome, "pay-provider");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 404 for a wallet that owns neither role on this booking", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(Keypair.random().publicKey()),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(response.status, 404);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 409 once a dispute is already open", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(response.status, 409);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/bookings/:id/resolve and GET /admin/disputes
// ---------------------------------------------------------------------------

test("POST /admin/bookings/:id/resolve: 404 for a wallet that is not an admin at all", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(Keypair.random().publicKey()),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "NOT_ADMIN");
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/bookings/:id/resolve: 403 NOT_DISPUTE_RESOLVER for an admin wallet that is not Pactly's own resolver", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(NON_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code: string }).code, "NOT_DISPUTE_RESOLVER");
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/bookings/:id/resolve: 400 for an invalid outcome, before the service is ever called", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "give-it-to-nobody" }),
    });
    assert.equal(response.status, 400);
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/bookings/:id/resolve: 404 BOOKING_NOT_FOUND for an unknown booking id", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${randomBytes(16).toString("hex")}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/bookings/:id/resolve: 200 for the dispute-resolver admin wallet, given chain-confirmed disputed evidence", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const adapter = fakeEscrowAdapter({ resolveDispute: async () => ({ unsignedXdr: "x", txHash: "resolve-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { txHash: string; outcome: string };
    assert.equal(body.txHash, "resolve-tx-hash");
    assert.equal(body.outcome, "refund-client");

    const booking = await getBookingById(result.db, seed.bookingId);
    assert.equal(booking?.escrowResolveTxHash, "resolve-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("GET /admin/disputes: 404 for a non-admin wallet; 200 with the open dispute for an admin wallet", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const disputeAdapter = fakeEscrowAdapter({ startDispute: async () => ({ unsignedXdr: "x", txHash: "dispute-tx-hash" }) });
    const disputeApp = createApp(result.db, { escrowAdapter: disputeAdapter });
    const openResponse = await disputeApp.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "no-show" }),
    });
    assert.equal(openResponse.status, 200);
    // The reconciler's own later chain confirmation.
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      lifecycleAction: "disputed",
      amount: "1000000",
      ledgerSeq: "2",
      isAnomaly: false,
      processedAt: Date.now(),
    });

    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const nonAdmin = await app.request("/admin/disputes", { method: "GET", headers: await authHeader(Keypair.random().publicKey()) });
    assert.equal(nonAdmin.status, 404);

    // Any admin wallet may view the list -- not only the dispute resolver.
    const asAdmin = await app.request("/admin/disputes", { method: "GET", headers: await authHeader(NON_RESOLVER_ADMIN_WALLET) });
    assert.equal(asAdmin.status, 200);
    const body = (await asAdmin.json()) as { disputes: Array<{ bookingId: string; reason: string; suggestedOutcome?: string }> };
    assert.equal(body.disputes.length, 1);
    assert.equal(body.disputes[0]?.bookingId, seed.bookingId);
    assert.equal(body.disputes[0]?.reason, "no-show");
    assert.equal(body.disputes[0]?.suggestedOutcome, "pay-provider");
  } finally {
    closeDatabase(result);
  }
});
