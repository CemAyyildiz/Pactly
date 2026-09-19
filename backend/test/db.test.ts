/**
 * Small db-layer tests: bookings, the event worker's cursor, and the
 * processed-events dedupe ledger, each against a real temporary SQLite
 * database. Includes the I/O matrix's amount round-trip row: an `i128`
 * amount at the top of the range stored and read back as the identical
 * string, with no precision lost.
 */
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { getBookingById, updateBalanceState, updateEscrowState } from "../src/db/bookings.js";
import { getAnchorJwt, upsertAnchorJwt } from "../src/db/anchorJwts.js";
import { redeemChallengeNonceIfUnused } from "../src/db/challengeNonces.js";
import { getCursor, setCursor } from "../src/db/cursor.js";
import { getProcessedEvent, insertProcessedEventIfNew } from "../src/db/processedEvents.js";
import { providerApplications, reviews } from "../src/db/schema.js";
import { processEvent } from "../src/chain/event-worker.js";
import { closeDatabase, fakeChainEvent, openTestDatabase, randomBookingId, seedBooking, seedCategory } from "./helpers.js";

/** 2^127 - 1: the top of the signed i128 range the contract's deposit
 * amount type can hold (AD-7 -- stored and carried as a string, never a
 * float, never a SQLite INTEGER, which cannot hold this without loss). */
const I128_MAX = "170141183460469231731687303715884105727";

test("an i128-max deposit amount is stored and read back as the identical string", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result, { depositAmount: I128_MAX });
    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.depositAmount, I128_MAX);
    assert.equal(typeof booking?.depositAmount, "string");
  } finally {
    closeDatabase(result);
  }
});

test("updateEscrowState touches only escrow_state, never balance_state", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result, { balanceState: "paid_platform" });
    await updateEscrowState(result.db, bookingId, "locked");
    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowState, "locked");
    assert.equal(booking?.balanceState, "paid_platform");
  } finally {
    closeDatabase(result);
  }
});

test("updateBalanceState touches only balance_state, never escrow_state", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    // Route escrow_state through the real single writer (the event worker)
    // rather than calling updateEscrowState directly as a stand-in for it:
    // only chain/event-worker.ts may write escrow_state (AD-1/AD-3), and a
    // test helper that writes it directly is exactly the "test helper that
    // pretends to be [the event worker]" case the spec's Never list rules
    // out. `updateEscrowState touches only escrow_state...` above is the
    // one legitimate exception -- it is db/bookings.ts's own unit test.
    await processEvent(result.db, fakeChainEvent({ bookingId, eventType: "released" }));
    await updateBalanceState(result.db, bookingId, "paid_cash");
    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.balanceState, "paid_cash");
    assert.equal(booking?.escrowState, "released");
  } finally {
    closeDatabase(result);
  }
});

test("updateEscrowState throws for an unknown booking id instead of silently writing nothing", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => updateEscrowState(result.db, randomBookingId(), "locked"), TypeError);
  } finally {
    closeDatabase(result);
  }
});

test("updateBalanceState throws for an unknown booking id instead of silently writing nothing", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => updateBalanceState(result.db, randomBookingId(), "paid_cash"), TypeError);
  } finally {
    closeDatabase(result);
  }
});

test("getCursor is undefined before the worker has ever run", async () => {
  const result = openTestDatabase();
  try {
    assert.equal(await getCursor(result.db), undefined);
  } finally {
    closeDatabase(result);
  }
});

test("setCursor persists and can be updated in place (restart resumes from the latest value)", async () => {
  const result = openTestDatabase();
  try {
    await setCursor(result.db, "cursor-1");
    assert.equal(await getCursor(result.db), "cursor-1");
    await setCursor(result.db, "cursor-2");
    assert.equal(await getCursor(result.db), "cursor-2");
  } finally {
    closeDatabase(result);
  }
});

test("getAnchorJwt is undefined for a wallet with no cached anchor JWT", async () => {
  const result = openTestDatabase();
  try {
    assert.equal(await getAnchorJwt(result.db, "GNOCACHE"), undefined);
  } finally {
    closeDatabase(result);
  }
});

test("upsertAnchorJwt writes a wallet's anchor JWT and getAnchorJwt reads it back", async () => {
  const result = openTestDatabase();
  try {
    await upsertAnchorJwt(result.db, { walletAddress: "GWALLET1", jwt: "jwt-1", expiresAt: 1_000 });
    const row = await getAnchorJwt(result.db, "GWALLET1");
    assert.equal(row?.jwt, "jwt-1");
    assert.equal(row?.expiresAt, 1_000);
  } finally {
    closeDatabase(result);
  }
});

test("upsertAnchorJwt replaces a wallet's cached anchor JWT in place (never a second row)", async () => {
  const result = openTestDatabase();
  try {
    await upsertAnchorJwt(result.db, { walletAddress: "GWALLET1", jwt: "jwt-1", expiresAt: 1_000 });
    await upsertAnchorJwt(result.db, { walletAddress: "GWALLET1", jwt: "jwt-2", expiresAt: 2_000 });
    const row = await getAnchorJwt(result.db, "GWALLET1");
    assert.equal(row?.jwt, "jwt-2");
    assert.equal(row?.expiresAt, 2_000);
  } finally {
    closeDatabase(result);
  }
});

test("redeemChallengeNonceIfUnused returns true for a fresh nonce and false for a replay of the same one", async () => {
  const result = openTestDatabase();
  try {
    const first = await redeemChallengeNonceIfUnused(result.db, "nonce-1", Date.now() + 1_000);
    assert.equal(first, true);
    const replay = await redeemChallengeNonceIfUnused(result.db, "nonce-1", Date.now() + 1_000);
    assert.equal(replay, false);
  } finally {
    closeDatabase(result);
  }
});

test("redeemChallengeNonceIfUnused treats different nonces independently", async () => {
  const result = openTestDatabase();
  try {
    assert.equal(await redeemChallengeNonceIfUnused(result.db, "nonce-a", Date.now() + 1_000), true);
    assert.equal(await redeemChallengeNonceIfUnused(result.db, "nonce-b", Date.now() + 1_000), true);
  } finally {
    closeDatabase(result);
  }
});

test("insertProcessedEventIfNew returns true for a fresh (booking_id, event_type) and false for a replay", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const event = {
      bookingId,
      eventType: "locked",
      amount: "1000000",
      ledger: 1,
      eventId: "evt-1",
      isAnomaly: false,
      processedAt: Date.now(),
    };
    assert.equal(await insertProcessedEventIfNew(result.db, event), true);
    assert.equal(await insertProcessedEventIfNew(result.db, { ...event, eventId: "evt-2" }), false);

    const row = await getProcessedEvent(result.db, bookingId, "locked");
    assert.equal(row?.eventId, "evt-1");
  } finally {
    closeDatabase(result);
  }
});

// The two tests below insert and select through the Drizzle table objects
// directly, for tables nothing else in the codebase reads or writes yet
// (provider_applications, reviews -- future stories' job). `migrations.ts`
// is hand-written DDL, an untyped string TypeScript never checks against
// `schema.ts`; only a real SQLite round trip through both declarations
// together can catch them drifting apart (a renamed or dropped DDL column
// leaves typecheck clean and would otherwise ship silently).

test("provider_applications round-trips through the Drizzle schema (DDL agrees with schema.ts)", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result);
    const id = randomUUID();
    await result.db.insert(providerApplications).values({
      id,
      walletAddress: "GAPPLICANTWALLET",
      name: "Jane Professional",
      title: "Licensed Therapist",
      categoryId,
      serviceDescription: "1:1 sessions",
      sessionFormat: "video",
      sessionLengthMinutes: 50,
      sessionPriceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
      createdAt: Date.now(),
    });

    const rows = await result.db.select().from(providerApplications).where(eq(providerApplications.id, id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.walletAddress, "GAPPLICANTWALLET");
    assert.equal(rows[0]?.categoryId, categoryId);
    assert.equal(rows[0]?.state, "pending");
  } finally {
    closeDatabase(result);
  }
});

test("reviews round-trips through the Drizzle schema (DDL agrees with schema.ts)", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const id = randomUUID();
    await result.db.insert(reviews).values({
      id,
      bookingId,
      clientWalletAddress: "GCLIENTREVIEWWALLET",
      rating: 5,
      comment: "Great session",
      createdAt: Date.now(),
    });

    const rows = await result.db.select().from(reviews).where(eq(reviews.id, id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.bookingId, bookingId);
    assert.equal(rows[0]?.rating, 5);
    assert.equal(rows[0]?.comment, "Great session");
  } finally {
    closeDatabase(result);
  }
});
