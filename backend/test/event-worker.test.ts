/**
 * The event worker driven as a unit, over a real temporary SQLite database
 * (`openDatabase(":memory:")`) through its injected `FetchEvents` seam --
 * never against the network. Covers the I/O-matrix rows the spec names:
 * booking mirrored, same event twice, restart, payout events distinguished,
 * provider cancellation, unknown booking id, and the two states staying
 * independent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { processEvent, runEventWorkerOnce, escrowStateForEvent } from "../src/chain/event-worker.js";
import { getBookingById } from "../src/db/bookings.js";
import { getCursor } from "../src/db/cursor.js";
import { getProcessedEvent } from "../src/db/processedEvents.js";
import type { FetchEvents } from "../src/chain/events.js";
import { closeDatabase, fakeChainEvent, openTestDatabase, randomBookingId, seedBooking } from "./helpers.js";

test("a locked event sets escrow_state and leaves balance_state untouched", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const outcome = await processEvent(result.db, fakeChainEvent({ bookingId, eventType: "locked" }));
    assert.equal(outcome, "applied");
    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowState, "locked");
    assert.equal(booking?.balanceState, "unpaid");
  } finally {
    closeDatabase(result);
  }
});

test("replaying the same (booking_id, event_type) changes nothing and inserts no duplicate row", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const first = await processEvent(result.db, fakeChainEvent({ bookingId, eventType: "locked", id: "evt-1" }));
    assert.equal(first, "applied");

    // A replay carries the chain's own new event id (RPC redelivery), but
    // the same (bookingId, eventType) -- that pair is the dedupe key, not
    // the event id.
    const second = await processEvent(result.db, fakeChainEvent({ bookingId, eventType: "locked", id: "evt-2" }));
    assert.equal(second, "duplicate");

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowState, "locked");

    const row = await getProcessedEvent(result.db, bookingId, "locked");
    assert.ok(row);
    // The composite primary key on (booking_id, event_type) already
    // guarantees only one row can exist; this asserts it holds the first
    // event's id, confirming the second call was a genuine no-op insert.
    assert.equal(row.eventId, "evt-1");
  } finally {
    closeDatabase(result);
  }
});

test("a restarted worker resumes from the stored cursor, not from the start", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);

    const firstFetch: FetchEvents = async (cursor) => {
      assert.equal(cursor, undefined, "first run should fetch from the beginning");
      return {
        events: [fakeChainEvent({ bookingId, eventType: "locked" })],
        cursor: "cursor-after-first-batch",
      };
    };
    const firstResult = await runEventWorkerOnce({ db: result.db, fetchEvents: firstFetch });
    assert.equal(firstResult.applied, 1);
    assert.equal(firstResult.cursor, "cursor-after-first-batch");
    assert.equal(await getCursor(result.db), "cursor-after-first-batch");

    let secondFetchCalledWith: string | undefined;
    const secondFetch: FetchEvents = async (cursor) => {
      secondFetchCalledWith = cursor;
      return { events: [], cursor: "cursor-after-second-batch" };
    };
    await runEventWorkerOnce({ db: result.db, fetchEvents: secondFetch });
    assert.equal(secondFetchCalledWith, "cursor-after-first-batch", "restart must resume from the stored cursor");
    assert.equal(await getCursor(result.db), "cursor-after-second-batch");
  } finally {
    closeDatabase(result);
  }
});

test("released and forfeited both set escrow_state to released but are stored as distinct event types", async () => {
  const result = openTestDatabase();
  try {
    const releasedBooking = await seedBooking(result);
    const forfeitedBooking = await seedBooking(result);

    await processEvent(result.db, fakeChainEvent({ bookingId: releasedBooking, eventType: "released" }));
    await processEvent(result.db, fakeChainEvent({ bookingId: forfeitedBooking, eventType: "forfeited" }));

    const released = await getBookingById(result.db, releasedBooking);
    const forfeited = await getBookingById(result.db, forfeitedBooking);
    assert.equal(released?.escrowState, "released");
    assert.equal(forfeited?.escrowState, "released");

    const releasedEvent = await getProcessedEvent(result.db, releasedBooking, "released");
    const forfeitedEvent = await getProcessedEvent(result.db, forfeitedBooking, "forfeited");
    assert.equal(releasedEvent?.eventType, "released");
    assert.equal(forfeitedEvent?.eventType, "forfeited");
    assert.notEqual(releasedEvent?.eventType, forfeitedEvent?.eventType);
  } finally {
    closeDatabase(result);
  }
});

test("a cancelled event maps to refunded and is recorded as cancelled, not conflated with a client refund", async () => {
  const result = openTestDatabase();
  try {
    const cancelledBooking = await seedBooking(result);
    const refundedBooking = await seedBooking(result);

    await processEvent(result.db, fakeChainEvent({ bookingId: cancelledBooking, eventType: "cancelled" }));
    await processEvent(result.db, fakeChainEvent({ bookingId: refundedBooking, eventType: "refunded" }));

    const cancelled = await getBookingById(result.db, cancelledBooking);
    const refunded = await getBookingById(result.db, refundedBooking);
    assert.equal(cancelled?.escrowState, "refunded");
    assert.equal(refunded?.escrowState, "refunded");

    const cancelledEvent = await getProcessedEvent(result.db, cancelledBooking, "cancelled");
    const refundedEvent = await getProcessedEvent(result.db, refundedBooking, "refunded");
    assert.equal(cancelledEvent?.eventType, "cancelled");
    assert.equal(refundedEvent?.eventType, "refunded");
  } finally {
    closeDatabase(result);
  }
});

test("an event for an unknown booking id invents no row, is recorded as an anomaly, and the worker continues", async () => {
  const result = openTestDatabase();
  try {
    const unknownBookingId = randomBookingId();
    const messages: string[] = [];
    const outcome = await processEvent(
      result.db,
      fakeChainEvent({ bookingId: unknownBookingId, eventType: "locked" }),
      (message) => messages.push(message),
    );
    assert.equal(outcome, "anomaly");
    assert.equal(await getBookingById(result.db, unknownBookingId), undefined, "no row should be invented");

    const row = await getProcessedEvent(result.db, unknownBookingId, "locked");
    assert.equal(row?.isAnomaly, true);
    assert.ok(messages.some((message) => message.includes("anomaly")));

    // "the worker continues": a batch with the unknown-id event followed by
    // a known one must not throw, and must still apply the known one.
    const knownBooking = await seedBooking(result);
    const fetchEvents: FetchEvents = async () => ({
      events: [
        fakeChainEvent({ bookingId: randomBookingId(), eventType: "released" }),
        fakeChainEvent({ bookingId: knownBooking, eventType: "locked" }),
      ],
      cursor: "cursor-after-batch",
    });
    const batchResult = await runEventWorkerOnce({ db: result.db, fetchEvents });
    assert.equal(batchResult.anomalies, 1);
    assert.equal(batchResult.applied, 1);
    assert.equal((await getBookingById(result.db, knownBooking))?.escrowState, "locked");
  } finally {
    closeDatabase(result);
  }
});

test("a booking already paid_cash stays paid_cash when a released event arrives; only escrow_state changes", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result, { balanceState: "paid_cash" });
    const before = await getBookingById(result.db, bookingId);
    assert.equal(before?.balanceState, "paid_cash");
    assert.equal(before?.escrowState, null);

    const outcome = await processEvent(result.db, fakeChainEvent({ bookingId, eventType: "released" }));
    assert.equal(outcome, "applied");

    const after = await getBookingById(result.db, bookingId);
    assert.equal(after?.balanceState, "paid_cash");
    assert.equal(after?.escrowState, "released");
  } finally {
    closeDatabase(result);
  }
});

test("a failure between the dedupe insert and the escrow-state write leaves nothing committed, so the event is still re-processable", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const event = fakeChainEvent({ bookingId, eventType: "locked", id: "evt-1" });

    // Simulate a crash (or a throwing write) between the dedupe insert and
    // the escrow-state write, via the smallest seam processEvent exposes
    // for exactly this.
    await assert.rejects(() =>
      processEvent(result.db, event, undefined, {
        updateEscrowState: () => {
          throw new Error("simulated failure between the dedupe insert and the escrow-state write");
        },
      }),
    );

    // Nothing committed: no dedupe row, no escrow_state write. If the two
    // writes were not atomic, the dedupe row would already be there and
    // escrow_state would still be null -- permanently, since nothing ever
    // revisits a "duplicate".
    assert.equal(await getProcessedEvent(result.db, bookingId, "locked"), undefined);
    assert.equal((await getBookingById(result.db, bookingId))?.escrowState, null);

    // A retry with the real writer must see a fresh event ("applied"), not
    // a false "duplicate" -- the whole point of the fix.
    const outcome = await processEvent(result.db, event);
    assert.equal(outcome, "applied");
    assert.equal((await getBookingById(result.db, bookingId))?.escrowState, "locked");
  } finally {
    closeDatabase(result);
  }
});

test("escrowStateForEvent maps all five event names to the right of the three escrow states", () => {
  assert.equal(escrowStateForEvent("locked"), "locked");
  assert.equal(escrowStateForEvent("released"), "released");
  assert.equal(escrowStateForEvent("forfeited"), "released");
  assert.equal(escrowStateForEvent("refunded"), "refunded");
  assert.equal(escrowStateForEvent("cancelled"), "refunded");
});
