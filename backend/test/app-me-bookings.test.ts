/**
 * Story 3.5's two list routes (`GET /me/bookings`, `GET /me/provider/
 * bookings`), driven through Hono's own `app.request(...)` -- same pattern
 * as `app-bookings.test.ts`. Covers the I/O matrix's own rows: the client
 * list, the provider list, isolation on both sides, the empty list, a
 * resolved dispute's lifecycle surfacing to both sides, and an expired hold
 * staying in the list (never silently dropped) with `isExpiredHold: true`.
 * "Window closed" (cancelDeadline in the past) is pure passthrough of a
 * field already asserted below -- there is no backend behavior distinct
 * from returning `cancelDeadline` itself, so it gets no separate test.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { updateEscrowContractId, updateEscrowState } from "../src/db/bookings.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import { recordEscrowDisputeResolution } from "../src/db/escrowDisputeResolutions.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) };

async function authHeader(walletAddress: string): Promise<Record<string, string>> {
  const token = await issuePactlyJwt(walletAddress);
  return { authorization: `Bearer ${token}` };
}

interface ListItem {
  id: string;
  slotStartsAt: number | null;
  escrowState: string | null;
  lifecycle: { action?: string; outcome?: string };
  balanceState: string;
  contractId: string | null;
  isExpiredHold: boolean;
  provider?: { id: string; displayName: string; title: string };
  clientWalletAddress?: string;
}

test("GET /me/bookings gives 401 with no token", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await app.request("/me/bookings");
    assert.equal(response.status, 401);
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/bookings returns an empty list for a wallet with no bookings", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const headers = await authHeader("GNOBOOKINGSCLIENT");
    const response = await app.request("/me/bookings", { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bookings: ListItem[] };
    assert.deepEqual(body.bookings, []);
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/bookings returns only the caller's own bookings, across providers, ordered by appointment date", async () => {
  const result = openTestDatabase();
  try {
    const providerA = await seedProviderProfile(result, { isApproved: true, displayName: "Provider A" });
    const providerB = await seedProviderProfile(result, { isApproved: true, displayName: "Provider B" });
    const now = Math.floor(Date.now() / 1000);
    const laterSlot = now + 7200;
    const soonerSlot = now + 3600;
    await replaceFutureSlots(result.db, providerA, [laterSlot]);
    await replaceFutureSlots(result.db, providerB, [soonerSlot]);

    const client = "GORDEREDCLIENT";
    const holdA = await holdSlot(result.db, { providerProfileId: providerA, clientWalletAddress: client, slotStartsAt: laterSlot }, FAKE_USDC_DEPS);
    const holdB = await holdSlot(result.db, { providerProfileId: providerB, clientWalletAddress: client, slotStartsAt: soonerSlot }, FAKE_USDC_DEPS);

    // A different client's own booking must never appear in `client`'s list
    // (the spec's own "Isolation" row). `laterSlot` already carries an
    // active booking, so `replaceFutureSlots` must preserve it (Story 3.4)
    // while adding the third slot this second hold needs.
    const otherClientSlot = now + 10800;
    await replaceFutureSlots(result.db, providerA, [laterSlot, otherClientSlot]);
    await holdSlot(result.db, { providerProfileId: providerA, clientWalletAddress: "GOTHERCLIENT", slotStartsAt: otherClientSlot }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = await authHeader(client);
    const response = await app.request("/me/bookings", { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bookings: ListItem[] };

    assert.equal(body.bookings.length, 2);
    assert.deepEqual(
      body.bookings.map((item) => item.id),
      [holdB.bookingId, holdA.bookingId],
    );
    assert.ok(body.bookings.every((item) => item.id !== undefined));
    const first = body.bookings[0]!;
    assert.equal(first.slotStartsAt, soonerSlot);
    assert.equal(first.escrowState, null);
    assert.equal(first.balanceState, "unpaid");
    assert.equal(first.isExpiredHold, false);
    assert.ok(first.provider);
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/bookings sorts past appointments most-recent-first, after any upcoming ones", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const client = "GPASTORDERCLIENT";

    // Two already-locked past appointments (not expired holds -- this
    // isolates the past-vs-past ordering from the `isExpiredHold` grouping),
    // the older one seeded first so insertion order can never be mistaken
    // for the sort order under test.
    const olderPastNow = now - 20000;
    const olderPastSlot = olderPastNow + 1200;
    await replaceFutureSlots(result.db, providerProfileId, [olderPastSlot], olderPastNow);
    const olderPastHold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: client, slotStartsAt: olderPastSlot },
      { ...FAKE_USDC_DEPS, now: olderPastNow },
    );
    await updateEscrowContractId(result.db, olderPastHold.bookingId, "COLDERPASTCONTRACT000000000000000000000000000000000");
    await updateEscrowState(result.db, olderPastHold.bookingId, "locked");

    const recentPastNow = now - 10000;
    const recentPastSlot = recentPastNow + 1200;
    await replaceFutureSlots(result.db, providerProfileId, [recentPastSlot], recentPastNow);
    const recentPastHold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: client, slotStartsAt: recentPastSlot },
      { ...FAKE_USDC_DEPS, now: recentPastNow },
    );
    await updateEscrowContractId(result.db, recentPastHold.bookingId, "CRECENTPASTCONTRACT00000000000000000000000000000000");
    await updateEscrowState(result.db, recentPastHold.bookingId, "locked");

    // One upcoming hold -- must sort before both past ones.
    const upcomingSlot = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [upcomingSlot]);
    const upcomingHold = await holdSlot(result.db, { providerProfileId, clientWalletAddress: client, slotStartsAt: upcomingSlot }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const response = await app.request("/me/bookings", { headers: await authHeader(client) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bookings: ListItem[] };
    assert.deepEqual(
      body.bookings.map((item) => item.id),
      [upcomingHold.bookingId, recentPastHold.bookingId, olderPastHold.bookingId],
    );
  } finally {
    closeDatabase(result);
  }
});

test("getEscrowLifecycleForBookings groups lifecycle rows per booking, never mixing two bookings' own history", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const client = "GTWOLIFECYCLESCLIENT";

    const fundedSlot = now + 3600;
    const resolvedSlot = now + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [fundedSlot, resolvedSlot]);

    const fundedHold = await holdSlot(result.db, { providerProfileId, clientWalletAddress: client, slotStartsAt: fundedSlot }, FAKE_USDC_DEPS);
    const fundedContractId = "CFUNDEDGROUPCONTRACT0000000000000000000000000000000";
    await updateEscrowContractId(result.db, fundedHold.bookingId, fundedContractId);
    await updateEscrowState(result.db, fundedHold.bookingId, "locked");
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: fundedHold.bookingId,
      contractId: fundedContractId,
      lifecycleAction: "funded",
      amount: fundedHold.deposit.amount,
      ledgerSeq: "1",
      isAnomaly: false,
      processedAt: Date.now(),
    });

    const resolvedHold = await holdSlot(result.db, { providerProfileId, clientWalletAddress: client, slotStartsAt: resolvedSlot }, FAKE_USDC_DEPS);
    const resolvedContractId = "CRESOLVEDGROUPCONTRACT00000000000000000000000000000";
    await updateEscrowContractId(result.db, resolvedHold.bookingId, resolvedContractId);
    await updateEscrowState(result.db, resolvedHold.bookingId, "released");
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: resolvedHold.bookingId,
      contractId: resolvedContractId,
      lifecycleAction: "resolved",
      amount: "0",
      ledgerSeq: "1",
      isAnomaly: false,
      processedAt: Date.now(),
    });
    await recordEscrowDisputeResolution(result.db, {
      bookingId: resolvedHold.bookingId,
      contractId: resolvedContractId,
      outcome: "pay-provider",
      txHash: "faketxhashgroup",
      decidedAt: Date.now(),
    });

    const app = createApp(result.db);
    const response = await app.request("/me/bookings", { headers: await authHeader(client) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bookings: ListItem[] };
    assert.equal(body.bookings.length, 2);

    const fundedItem = body.bookings.find((item) => item.id === fundedHold.bookingId);
    const resolvedItem = body.bookings.find((item) => item.id === resolvedHold.bookingId);
    assert.ok(fundedItem, "the funded booking must be in the list");
    assert.ok(resolvedItem, "the resolved booking must be in the list");
    // Each booking's own lifecycle must stay its own -- a grouping bug would
    // either mix the two contracts' events or lose one booking's action.
    assert.equal(fundedItem?.lifecycle.action, "funded");
    assert.equal(fundedItem?.lifecycle.outcome, undefined);
    assert.equal(resolvedItem?.lifecycle.action, "resolved");
    assert.equal(resolvedItem?.lifecycle.outcome, "pay-provider");
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/provider/bookings gives 404 NOT_A_PROVIDER for a wallet with no provider profile", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const headers = await authHeader("GNOTAPROVIDER");
    const response = await app.request("/me/provider/bookings", { headers });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "NOT_A_PROVIDER");
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/provider/bookings returns only the caller's own incoming bookings", async () => {
  const result = openTestDatabase();
  try {
    const providerAWallet = "GPROVIDERAWALLET";
    const providerBWallet = "GPROVIDERBWALLET";
    const providerA = await seedProviderProfile(result, { isApproved: true, walletAddress: providerAWallet });
    const providerB = await seedProviderProfile(result, { isApproved: true, walletAddress: providerBWallet });
    const now = Math.floor(Date.now() / 1000);
    const slotA = now + 3600;
    const slotB = now + 3600;
    await replaceFutureSlots(result.db, providerA, [slotA]);
    await replaceFutureSlots(result.db, providerB, [slotB]);

    const holdA = await holdSlot(result.db, { providerProfileId: providerA, clientWalletAddress: "GCLIENTFORA", slotStartsAt: slotA }, FAKE_USDC_DEPS);
    await holdSlot(result.db, { providerProfileId: providerB, clientWalletAddress: "GCLIENTFORB", slotStartsAt: slotB }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = await authHeader(providerAWallet);
    const response = await app.request("/me/provider/bookings", { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bookings: ListItem[] };
    assert.equal(body.bookings.length, 1);
    assert.equal(body.bookings[0]!.id, holdA.bookingId);
    assert.equal(body.bookings[0]!.clientWalletAddress, "GCLIENTFORA");
  } finally {
    closeDatabase(result);
  }
});

test("a funded booking shows escrowState locked and lifecycle action funded to both sides (acceptance criteria)", async () => {
  const result = openTestDatabase();
  try {
    const providerWallet = "GFUNDEDPROVIDERWALLET";
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });
    const now = Math.floor(Date.now() / 1000);
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GFUNDEDCLIENTWALLET";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const contractId = "CFUNDEDCONTRACT00000000000000000000000000000000000";
    await updateEscrowContractId(result.db, hold.bookingId, contractId);
    await updateEscrowState(result.db, hold.bookingId, "locked");
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: hold.bookingId,
      contractId,
      lifecycleAction: "funded",
      amount: hold.deposit.amount,
      ledgerSeq: "1",
      isAnomaly: false,
      processedAt: Date.now(),
    });

    const app = createApp(result.db);

    const clientResponse = await app.request("/me/bookings", { headers: await authHeader(clientWalletAddress) });
    const clientBody = (await clientResponse.json()) as { bookings: ListItem[] };
    assert.equal(clientBody.bookings[0]!.escrowState, "locked");
    assert.equal(clientBody.bookings[0]!.lifecycle.action, "funded");
    assert.equal(clientBody.bookings[0]!.contractId ?? contractId, contractId);

    const providerResponse = await app.request("/me/provider/bookings", { headers: await authHeader(providerWallet) });
    const providerBody = (await providerResponse.json()) as { bookings: ListItem[] };
    assert.equal(providerBody.bookings[0]!.escrowState, "locked");
    assert.equal(providerBody.bookings[0]!.lifecycle.action, "funded");
  } finally {
    closeDatabase(result);
  }
});

test("a resolved dispute's outcome surfaces identically to both the client and provider lists", async () => {
  const result = openTestDatabase();
  try {
    const providerWallet = "GRESOLVEDPROVIDERWALLET";
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });
    const now = Math.floor(Date.now() / 1000);
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GRESOLVEDCLIENTWALLET";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const contractId = "CRESOLVEDCONTRACT0000000000000000000000000000000000";
    await updateEscrowContractId(result.db, hold.bookingId, contractId);
    await updateEscrowState(result.db, hold.bookingId, "refunded");
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: hold.bookingId,
      contractId,
      lifecycleAction: "resolved",
      amount: "0",
      ledgerSeq: "2",
      isAnomaly: false,
      processedAt: Date.now(),
    });
    await recordEscrowDisputeResolution(result.db, {
      bookingId: hold.bookingId,
      contractId,
      outcome: "refund-client",
      txHash: "faketxhash",
      decidedAt: Date.now(),
    });

    const app = createApp(result.db);

    const clientResponse = await app.request("/me/bookings", { headers: await authHeader(clientWalletAddress) });
    const clientBody = (await clientResponse.json()) as { bookings: ListItem[] };
    assert.equal(clientBody.bookings[0]!.lifecycle.action, "resolved");
    assert.equal(clientBody.bookings[0]!.lifecycle.outcome, "refund-client");
    assert.equal(clientBody.bookings[0]!.escrowState, "refunded");

    const providerResponse = await app.request("/me/provider/bookings", { headers: await authHeader(providerWallet) });
    const providerBody = (await providerResponse.json()) as { bookings: ListItem[] };
    assert.equal(providerBody.bookings[0]!.lifecycle.action, "resolved");
    assert.equal(providerBody.bookings[0]!.lifecycle.outcome, "refund-client");
  } finally {
    closeDatabase(result);
  }
});

test("an expired hold is listed with isExpiredHold: true, never dropped", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const pastNow = now - 3600;
    const slotStartsAt = pastNow + 1200;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], pastNow);
    const clientWalletAddress = "GEXPIREDHOLDCLIENT";
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress, slotStartsAt },
      { ...FAKE_USDC_DEPS, now: pastNow },
    );
    // Sanity: this hold really is expired relative to the real clock.
    assert.ok(hold.holdExpiresAt < now);

    const app = createApp(result.db);
    const response = await app.request("/me/bookings", { headers: await authHeader(clientWalletAddress) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bookings: ListItem[] };
    const item = body.bookings.find((booking) => booking.id === hold.bookingId);
    assert.ok(item, "the expired hold's booking must still be returned, never dropped");
    assert.equal(item?.isExpiredHold, true);
    assert.equal(item?.escrowState, null);
  } finally {
    closeDatabase(result);
  }
});
