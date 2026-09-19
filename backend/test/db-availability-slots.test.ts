/**
 * `db/availabilitySlots.ts` against a real, temporary SQLite database:
 * `listFutureSlots`'s ordering and 30-day window, and `replaceFutureSlots`'s
 * atomic delete-then-insert, dedup+sort, and "past slots untouched"
 * guarantee (Story 3.1's I/O matrix).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { listEarliestFutureSlotsByProvider, listFutureSlots, replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

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

test("listEarliestFutureSlotsByProvider returns an empty map for an empty id list", async () => {
  const result = openTestDatabase();
  try {
    const byProvider = await listEarliestFutureSlotsByProvider(result.db, []);
    assert.equal(byProvider.size, 0);
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
