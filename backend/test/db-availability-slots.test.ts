/**
 * `db/availabilitySlots.ts` against a real, temporary SQLite database:
 * `listFutureSlots`'s ordering and 30-day window, and `replaceFutureSlots`'s
 * atomic delete-then-insert, dedup+sort, and "past slots untouched"
 * guarantee (Story 3.1's I/O matrix).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import {
  getSlotByProviderAndStart,
  listEarliestFutureSlotsByProvider,
  listFutureSlots,
  listOpenFutureSlots,
  listOpenSlotsInRange,
  replaceFutureSlots,
} from "../src/db/availabilitySlots.js";
import { insertBookingHoldIfSlotFree, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { availabilitySlots } from "../src/db/schema.js";
import { closeDatabase, openTestDatabase, randomBookingId, seedProviderProfile } from "./helpers.js";

const DAY = 24 * 60 * 60;

test("listFutureSlots returns only slots after now, ascending", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 3600, now + 1800, now + 900], now);

    const slots = await listFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(
      slots.map((slot) => slot.startsAt),
      [now + 900, now + 1800, now + 3600],
    );
  } finally {
    closeDatabase(result);
  }
});

test("listFutureSlots caps the window with withinSeconds (the public route's 30-day cap)", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    const withinWindow = now + 10 * DAY;
    const outsideWindow = now + 40 * DAY;
    await replaceFutureSlots(result.db, providerProfileId, [withinWindow, outsideWindow], now);

    const slots = await listFutureSlots(result.db, providerProfileId, { now, withinSeconds: 30 * DAY });
    assert.deepEqual(
      slots.map((slot) => slot.startsAt),
      [withinWindow],
    );
  } finally {
    closeDatabase(result);
  }
});

test("replaceFutureSlots dedupes and sorts the saved set", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 3600, now + 900, now + 3600], now);

    const slots = await listFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(
      slots.map((slot) => slot.startsAt),
      [now + 900, now + 3600],
    );
  } finally {
    closeDatabase(result);
  }
});

test("replaceFutureSlots replaces the whole future set on a second call", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 900, now + 1800], now);
    await replaceFutureSlots(result.db, providerProfileId, [now + 3600], now);

    const slots = await listFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(
      slots.map((slot) => slot.startsAt),
      [now + 3600],
    );
  } finally {
    closeDatabase(result);
  }
});

test("replaceFutureSlots leaves past slots untouched", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    // A "past" slot planted directly through the same replace call, dated
    // before `now` -- replaceFutureSlots only ever deletes startsAt > now,
    // so seeding it this way (rather than inventing a second write path)
    // still proves the guarantee against the one function under test.
    await replaceFutureSlots(result.db, providerProfileId, [now - 3600], now - 7200);
    await replaceFutureSlots(result.db, providerProfileId, [now + 900], now);

    const allSlots = await listFutureSlots(result.db, providerProfileId, { now: now - 7200 });
    assert.deepEqual(
      allSlots.map((slot) => slot.startsAt).sort((a, b) => a - b),
      [now - 3600, now + 900],
    );
  } finally {
    closeDatabase(result);
  }
});

test("listEarliestFutureSlotsByProvider caps each provider at the given limit, ascending", async () => {
  const result = openTestDatabase();
  try {
    const providerA = await seedProviderProfile(result);
    const providerB = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerA, [now + 3600, now + 900, now + 7200, now + 1800], now);
    await replaceFutureSlots(result.db, providerB, [now + 5400], now);

    const byProvider = await listEarliestFutureSlotsByProvider(result.db, [providerA, providerB], { now, limit: 2 });
    assert.deepEqual(byProvider.get(providerA), [now + 900, now + 1800]);
    assert.deepEqual(byProvider.get(providerB), [now + 5400]);
  } finally {
    closeDatabase(result);
  }
});

/** Seeds one booking that actively holds `slotId` -- a real hold via
 * {@link insertBookingHoldIfSlotFree}, the same write path `holdSlot`
 * (`services/booking.ts`) uses, so these tests exercise the exact
 * "active booking" definition {@link listOpenFutureSlots} and
 * {@link replaceFutureSlots} both read. */
async function holdSlotForTest(
  result: Awaited<ReturnType<typeof openTestDatabase>>,
  providerProfileId: string,
  slotId: string,
  now: number,
): Promise<void> {
  const inserted = await insertBookingHoldIfSlotFree(
    result.db,
    {
      id: randomBookingId(),
      providerProfileId,
      clientWalletAddress: "GCLIENTTEST00000000000000000000000000000000000000",
      tokenAddress: "CTOKENTEST0000000000000000000000000000000000000000",
      depositAmount: "1000000",
      cancelDeadline: now + 3600,
      slotId,
      holdExpiresAt: now + 600,
      createdAt: Date.now(),
    },
    now,
  );
  assert.equal(inserted, true, "test setup: the slot must have been free to hold");
}

test("listOpenFutureSlots excludes a slot that currently carries an active booking", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 900, now + 1800], now);
    const [openSlot, heldSlot] = await listFutureSlots(result.db, providerProfileId, { now });
    await holdSlotForTest(result, providerProfileId, heldSlot!.id, now);

    const openSlots = await listOpenFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(openSlots.map((slot) => slot.startsAt), [openSlot!.startsAt]);
  } finally {
    closeDatabase(result);
  }
});

test("listEarliestFutureSlotsByProvider omits a provider with no future slots (and past slots are never counted)", async () => {
  const result = openTestDatabase();
  try {
    const withSlots = await seedProviderProfile(result);
    const withoutSlots = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, withSlots, [now + 900], now);
    // Plant a slot that is only "past" relative to `now`, the same
    // technique `listFutureSlots`'s own test above uses.
    await replaceFutureSlots(result.db, withoutSlots, [now - 3600], now - 7200);

    const byProvider = await listEarliestFutureSlotsByProvider(result.db, [withSlots, withoutSlots], { now });
    assert.deepEqual(byProvider.get(withSlots), [now + 900]);
    assert.equal(byProvider.has(withoutSlots), false);
  } finally {
    closeDatabase(result);
  }
});

test("listOpenSlotsInRange returns only open slots within the half-open range", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    const dayStart = now + DAY; // a day boundary strictly in the future of `now`
    await replaceFutureSlots(result.db, providerProfileId, [dayStart + 3600, dayStart + 7200, dayStart + DAY + 900], now);

    const inRange = await listOpenSlotsInRange(result.db, providerProfileId, dayStart, dayStart + DAY, now);
    assert.deepEqual(inRange, [dayStart + 3600, dayStart + 7200]);
  } finally {
    closeDatabase(result);
  }
});

test("listEarliestFutureSlotsByProvider returns an empty map for an empty id list", async () => {
  const result = openTestDatabase();
  try {
    const byProvider = await listEarliestFutureSlotsByProvider(result.db, []);
    assert.equal(byProvider.size, 0);
  } finally {
    closeDatabase(result);
  }
});

test("getSlotByProviderAndStart finds the exact slot, and nothing for an unknown start time", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 900], now);

    const found = await getSlotByProviderAndStart(result.db, providerProfileId, now + 900);
    assert.equal(found?.startsAt, now + 900);
    const notFound = await getSlotByProviderAndStart(result.db, providerProfileId, now + 999);
    assert.equal(notFound, undefined);
  } finally {
    closeDatabase(result);
  }
});

test("replaceFutureSlots never deletes a slot that carries an active booking, even when the new set omits it (Story 3.4)", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 900, now + 1800], now);
    const beforeSlots = await listFutureSlots(result.db, providerProfileId, { now });
    const heldSlot = beforeSlots.find((slot) => slot.startsAt === now + 900)!;
    await holdSlotForTest(result, providerProfileId, heldSlot.id, now);

    // The provider's rules panel has no notion of bookings -- it resubmits
    // a set that completely omits the held slot's start time.
    await replaceFutureSlots(result.db, providerProfileId, [now + 3600], now);

    const afterSlots = await listFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(
      afterSlots.map((slot) => slot.startsAt).sort((a, b) => a - b),
      [now + 900, now + 3600],
      "the held slot must survive, alongside the newly saved one",
    );
    assert.equal(
      afterSlots.find((slot) => slot.startsAt === now + 900)?.id,
      heldSlot.id,
      "the held slot's own row (and id) must be the original one, never a fresh insert",
    );
  } finally {
    closeDatabase(result);
  }
});

test("replaceFutureSlots does not fail when the caller's new set still includes an already-held slot's start time", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 900], now);
    const [heldSlot] = await listFutureSlots(result.db, providerProfileId, { now });
    await holdSlotForTest(result, providerProfileId, heldSlot!.id, now);

    await replaceFutureSlots(result.db, providerProfileId, [now + 900, now + 1800], now);

    const afterSlots = await listFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(afterSlots.map((slot) => slot.startsAt).sort((a, b) => a - b), [now + 900, now + 1800]);
  } finally {
    closeDatabase(result);
  }
});

test("replaceFutureSlots keeps two different providers' slots independent", async () => {
  const result = openTestDatabase();
  try {
    const providerA = await seedProviderProfile(result);
    const providerB = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerA, [now + 900], now);
    await replaceFutureSlots(result.db, providerB, [now + 1800], now);

    const slotsA = await listFutureSlots(result.db, providerA, { now });
    const slotsB = await listFutureSlots(result.db, providerB, { now });
    assert.deepEqual(slotsA.map((slot) => slot.startsAt), [now + 900]);
    assert.deepEqual(slotsB.map((slot) => slot.startsAt), [now + 1800]);
  } finally {
    closeDatabase(result);
  }
});

test("replaceFutureSlots marks withdrawn (never hard-deletes) a removed slot an inactive booking still references -- an expired hold on a future slot (review follow-up)", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 900, now + 1800], now);
    const [expiredHoldSlot, keptSlot] = await listFutureSlots(result.db, providerProfileId, { now });

    // An *expired* hold on a future slot -- inactive (hold_expires_at is
    // already in the past), but the booking row still names this slot, so
    // foreign_keys=ON refuses a hard delete of it.
    const inserted = await insertBookingHoldIfSlotFree(
      result.db,
      {
        id: randomBookingId(),
        providerProfileId,
        clientWalletAddress: "GCLIENTTEST00000000000000000000000000000000000000",
        tokenAddress: "CTOKENTEST0000000000000000000000000000000000000000",
        depositAmount: "1000000",
        cancelDeadline: now + 3600,
        slotId: expiredHoldSlot!.id,
        holdExpiresAt: now - 1, // already expired
        createdAt: Date.now(),
      },
      now,
    );
    assert.equal(inserted, true);

    // The provider's rules panel resubmits a set that omits the
    // (inactive, but still referenced) slot entirely.
    await replaceFutureSlots(result.db, providerProfileId, [keptSlot!.startsAt], now);

    // It must not have been hard-deleted -- confirmed by reading the raw
    // row directly (a real delete would have thrown a foreign-key
    // constraint error rather than leaving this query with nothing to
    // find).
    const rawRows = await result.db.select().from(availabilitySlots).where(eq(availabilitySlots.id, expiredHoldSlot!.id));
    assert.equal(rawRows.length, 1, "the row must still exist, marked withdrawn rather than deleted");
    assert.ok(rawRows[0]!.withdrawnAt !== null, "withdrawn_at must be set");

    // Excluded from every future/open listing, the same as a deleted row
    // would be.
    const remainingFuture = await listFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(remainingFuture.map((slot) => slot.startsAt), [keptSlot!.startsAt]);
    const remainingOpen = await listOpenFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(remainingOpen.map((slot) => slot.startsAt), [keptSlot!.startsAt]);

    // Re-adding the exact same start time later clears the withdrawal
    // rather than trying (and failing, on the unique pair) to insert a
    // second row for it.
    await replaceFutureSlots(result.db, providerProfileId, [keptSlot!.startsAt, expiredHoldSlot!.startsAt], now);
    const afterReadd = await listFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(
      afterReadd.map((slot) => slot.startsAt).sort((a, b) => a - b),
      [keptSlot!.startsAt, expiredHoldSlot!.startsAt].sort((a, b) => a - b),
    );
    const reAddedRow = afterReadd.find((slot) => slot.startsAt === expiredHoldSlot!.startsAt);
    assert.equal(reAddedRow?.id, expiredHoldSlot!.id, "re-adding must reuse the original row, not insert a fresh one");
  } finally {
    closeDatabase(result);
  }
});

test("replaceFutureSlots hard-deletes a removed slot no booking has ever referenced", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 900, now + 1800], now);

    await replaceFutureSlots(result.db, providerProfileId, [now + 1800], now);

    const rawRows = await result.db.select().from(availabilitySlots).where(eq(availabilitySlots.providerProfileId, providerProfileId));
    assert.equal(rawRows.length, 1, "the unreferenced, removed slot must be gone entirely, not merely withdrawn");
  } finally {
    closeDatabase(result);
  }
});

test("a refunded booking does not keep its slot active -- listOpenFutureSlots offers it again, and it counts as unreferenced for replaceFutureSlots' own hard-delete decision", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result);
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 900], now);
    const [slot] = await listFutureSlots(result.db, providerProfileId, { now });

    const bookingId = randomBookingId();
    await insertBookingHoldIfSlotFree(
      result.db,
      {
        id: bookingId,
        providerProfileId,
        clientWalletAddress: "GCLIENTTEST00000000000000000000000000000000000000",
        tokenAddress: "CTOKENTEST0000000000000000000000000000000000000000",
        depositAmount: "1000000",
        cancelDeadline: now + 3600,
        slotId: slot!.id,
        holdExpiresAt: now + 600,
        createdAt: Date.now(),
      },
      now,
    );
    await updateEscrowContractId(result.db, bookingId, "CFAKECONTRACT000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, bookingId, "refunded");

    // A refunded booking must not be treated as "active" -- the slot is
    // offered again.
    const open = await listOpenFutureSlots(result.db, providerProfileId, { now });
    assert.deepEqual(open.map((s) => s.startsAt), [slot!.startsAt]);

    // And a refunded-only reference does not block a hard delete either,
    // since foreign_keys=ON still refuses it -- a refunded booking still
    // *exists* and still names this slot_id, so a real delete would still
    // throw; this must come back withdrawn, not deleted, and not crash.
    await replaceFutureSlots(result.db, providerProfileId, [], now);
    const rawRows = await result.db.select().from(availabilitySlots).where(eq(availabilitySlots.id, slot!.id));
    assert.equal(rawRows.length, 1);
    assert.ok(rawRows[0]!.withdrawnAt !== null);
  } finally {
    closeDatabase(result);
  }
});
