/**
 * The only place SQL touches the `availability_slots` table (Story 3.1).
 * Slots are concrete UTC-epoch-second rows, not a recurring rule -- see
 * `schema.ts`'s own comment on why, and the story's Design Notes ("Why
 * concrete slots, not weekly rules").
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notExists, or, sql } from "drizzle-orm";

import type { Db } from "./client.js";
import { availabilitySlots, bookings } from "./schema.js";

export type AvailabilitySlotRow = typeof availabilitySlots.$inferSelect;

/** Every slot for `providerProfileId` that currently carries an "active"
 * booking (Story 3.4, AD-13): a non-expired hold (`hold_expires_at > now`),
 * or a booking whose `escrowState` is non-null *and not* `"refunded"`.
 * Review follow-up: a refunded booking must not keep a slot taken forever
 * -- refunding means the deposit came back to the client, so the slot is
 * free again the same way an expired, never-locked hold is. `released` and
 * `locked` both still count as active (the appointment happened, or the
 * deposit is genuinely held). This is the one place that definition lives;
 * {@link replaceFutureSlots} and every open-slot listing below all read it
 * from here so the "active" boundary can never drift between them. */
function activeBookingForSlot(now: number) {
  return and(
    eq(bookings.slotId, availabilitySlots.id),
    or(
      and(isNotNull(bookings.escrowState), ne(bookings.escrowState, "refunded")),
      // Once `escrowState` is set at all, the pending-hold clock is moot
      // (chain evidence has already decided this booking's fate) -- so the
      // `holdExpiresAt` branch only ever applies while `escrowState` is
      // still `null`. Without this guard a refunded booking whose
      // `holdExpiresAt` simply hasn't been touched since (it is never
      // cleared on a state transition) would read as "active" again via
      // this second clause alone, defeating the whole point of excluding
      // `refunded` above.
      and(isNull(bookings.escrowState), gt(bookings.holdExpiresAt, now)),
    ),
  );
}

/** Same definition as {@link activeBookingForSlot}, evaluated in JS against
 * an already-fetched row -- used by {@link replaceFutureSlots}'s per-row
 * loop, which needs a plain boolean rather than a correlated SQL fragment. */
function isBookingActive(booking: Pick<typeof bookings.$inferSelect, "escrowState" | "holdExpiresAt">, now: number): boolean {
  if (booking.escrowState !== null) {
    return booking.escrowState !== "refunded";
  }
  return booking.holdExpiresAt !== null && booking.holdExpiresAt > now;
}

export interface ListFutureSlotsOptions {
  /** Injectable clock (UTC epoch seconds) -- defaults to the real one. */
  now?: number;
  /** Caps the window to `now + withinSeconds` (the public route's "next 30
   * days"). Omitted entirely for a provider's own view, which sees every
   * future slot regardless of how far out it is. */
  withinSeconds?: number;
}

/** Every slot for `providerProfileId` that starts after `now`, ascending --
 * "past slots untouched" (the I/O matrix) means a past slot is never
 * returned here either, not just never deleted. */
export async function listFutureSlots(
  db: Db,
  providerProfileId: string,
  options: ListFutureSlotsOptions = {},
): Promise<AvailabilitySlotRow[]> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const conditions = [
    eq(availabilitySlots.providerProfileId, providerProfileId),
    gt(availabilitySlots.startsAt, now),
    isNull(availabilitySlots.withdrawnAt),
  ];
  if (options.withinSeconds !== undefined) {
    conditions.push(lte(availabilitySlots.startsAt, now + options.withinSeconds));
  }
  return db
    .select()
    .from(availabilitySlots)
    .where(and(...conditions))
    .orderBy(asc(availabilitySlots.startsAt));
}

export interface EarliestFutureSlotsOptions {
  /** Injectable clock (UTC epoch seconds) -- defaults to the real one. */
  now?: number;
  /** Caps how many of each provider's earliest slots are kept -- the
   * card's "up to three earliest open slots" (Story 3.2 AC3). Unset keeps
   * every future slot for every requested provider. */
  limit?: number;
}

/**
 * Story 3.2: for every id in `providerProfileIds`, its earliest future
 * slots ascending, capped at `options.limit` -- one query for every
 * provider on the Discover list, not one query per provider (the spec's
 * own Code Map note), grouped into a per-provider array in code since this
 * workspace has no window-function query builder wired up. Also the
 * "soonest open slot" the list's own sort order reads from -- the first
 * entry of each provider's array is that provider's next slot, or `undefined`
 * if the map has no entry for it at all.
 */
export async function listEarliestFutureSlotsByProvider(
  db: Db,
  providerProfileIds: string[],
  options: EarliestFutureSlotsOptions = {},
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (providerProfileIds.length === 0) {
    return result;
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const rows = await db
    .select()
    .from(availabilitySlots)
    .where(
      and(
        inArray(availabilitySlots.providerProfileId, providerProfileIds),
        gt(availabilitySlots.startsAt, now),
        isNull(availabilitySlots.withdrawnAt),
        // Story 3.4: a held or locked slot is never advertised on a card.
        notExists(db.select({ one: sql`1` }).from(bookings).where(activeBookingForSlot(now))),
      ),
    )
    .orderBy(asc(availabilitySlots.providerProfileId), asc(availabilitySlots.startsAt));
  for (const row of rows) {
    const existing = result.get(row.providerProfileId);
    if (existing) {
      if (existing.length < limit) {
        existing.push(row.startsAt);
      }
    } else {
      result.set(row.providerProfileId, [row.startsAt]);
    }
  }
  return result;
}

/** Same as {@link listFutureSlots}, minus any slot that currently carries an
 * active booking (Story 3.4) -- what a *client* should ever be offered to
 * hold. A provider's own view (`getOwnProviderProfile`) still uses
 * {@link listFutureSlots} unfiltered, so a provider can see which of their
 * own slots are filled. */
export async function listOpenFutureSlots(
  db: Db,
  providerProfileId: string,
  options: ListFutureSlotsOptions = {},
): Promise<AvailabilitySlotRow[]> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const conditions = [
    eq(availabilitySlots.providerProfileId, providerProfileId),
    gt(availabilitySlots.startsAt, now),
    isNull(availabilitySlots.withdrawnAt),
    notExists(db.select({ one: sql`1` }).from(bookings).where(activeBookingForSlot(now))),
  ];
  if (options.withinSeconds !== undefined) {
    conditions.push(lte(availabilitySlots.startsAt, now + options.withinSeconds));
  }
  return db
    .select()
    .from(availabilitySlots)
    .where(and(...conditions))
    .orderBy(asc(availabilitySlots.startsAt));
}

/** A plain lookup by primary key -- `services/booking.ts`'s `getBookingView`
 * uses this to show a booking's own `slotStartsAt` without re-deriving it
 * from anything else. */
export async function getSlotById(db: Db, id: string): Promise<AvailabilitySlotRow | undefined> {
  const rows = await db.select().from(availabilitySlots).where(eq(availabilitySlots.id, id)).limit(1);
  return rows[0];
}

/** The exact slot `holdSlot` (`services/booking.ts`) is asked to hold --
 * `undefined` for an unknown start time, whether or not the provider has
 * ever had a slot there. Callers still check `startsAt > now` and openness
 * themselves; this is a plain lookup, not a validity check. */
export async function getSlotByProviderAndStart(
  db: Db,
  providerProfileId: string,
  startsAt: number,
): Promise<AvailabilitySlotRow | undefined> {
  const rows = await db
    .select()
    .from(availabilitySlots)
    .where(
      and(
        eq(availabilitySlots.providerProfileId, providerProfileId),
        eq(availabilitySlots.startsAt, startsAt),
        isNull(availabilitySlots.withdrawnAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/** The provider's other *open* slots within `[rangeStart, rangeEnd)`
 * (epoch seconds, half-open) -- the "that day's other open slots" the
 * `SLOT_TAKEN` response names (spec I/O matrix). Excludes taken slots the
 * same way {@link listOpenFutureSlots} does. */
export async function listOpenSlotsInRange(
  db: Db,
  providerProfileId: string,
  rangeStart: number,
  rangeEnd: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number[]> {
  const rows = await db
    .select({ startsAt: availabilitySlots.startsAt })
    .from(availabilitySlots)
    .where(
      and(
        eq(availabilitySlots.providerProfileId, providerProfileId),
        gt(availabilitySlots.startsAt, now),
        gte(availabilitySlots.startsAt, rangeStart),
        lt(availabilitySlots.startsAt, rangeEnd),
        isNull(availabilitySlots.withdrawnAt),
        notExists(db.select({ one: sql`1` }).from(bookings).where(activeBookingForSlot(now))),
      ),
    )
    .orderBy(asc(availabilitySlots.startsAt));
  return rows.map((row) => row.startsAt);
}

/**
 * Replaces every *future* slot for `providerProfileId` with `slots`
 * (deduplicated and sorted) in one transaction, so a reader (or a
 * concurrent save) never observes a half-replaced table. Past slots
 * (`startsAt <= now`) are left exactly as they are.
 *
 * Story 3.4 amendment (the story's own Design Notes, "Why replace-all-future
 * on save" in Story 3.1 flagged this as 3.4's job): a future slot that now
 * carries an active booking (a non-expired hold, or a locked/released
 * escrow) is never touched here, even when the caller's own `slots` array
 * omits it -- a provider's rules panel has no notion of bookings, so it
 * must not be able to silently free an already-held or already-locked
 * slot.
 *
 * Review follow-up: a removed slot that is *not* actively booked can still
 * be referenced by an *inactive* booking (an expired, never-locked hold, or
 * a refunded one) -- `foreign_keys=ON` refuses to delete a row `bookings.
 * slot_id` still points at, active or not, so a hard delete there would
 * throw a raw SQLite constraint error. Such a slot is marked
 * `withdrawn_at = now` instead (excluded from every open/public/card
 * listing, same as a deleted row would be); a slot with no booking at all
 * referencing it is still deleted outright. Re-adding the same start time
 * later clears `withdrawn_at` on the existing row rather than inserting a
 * second one for it (the unique `(providerProfileId, startsAt)` pair still
 * names one row per start time either way).
 *
 * Synchronous end to end inside the `db.transaction()` callback, per
 * better-sqlite3's contract (see `db/bookings.ts`'s own comment on this) --
 * no `await` anywhere in the callback.
 */
export async function replaceFutureSlots(
  db: Db,
  providerProfileId: string,
  slots: number[],
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const uniqueSorted = [...new Set(slots)].sort((a, b) => a - b);
  const desired = new Set(uniqueSorted);
  const createdAt = Date.now();

  db.transaction((tx) => {
    const futureSlots = tx
      .select()
      .from(availabilitySlots)
      .where(and(eq(availabilitySlots.providerProfileId, providerProfileId), gt(availabilitySlots.startsAt, now)))
      .all();

    for (const slot of futureSlots) {
      const bookingsForSlot = tx
        .select({ escrowState: bookings.escrowState, holdExpiresAt: bookings.holdExpiresAt })
        .from(bookings)
        .where(eq(bookings.slotId, slot.id))
        .all();
      const isActive = bookingsForSlot.some((booking) => isBookingActive(booking, now));

      if (isActive) {
        // Never touched, regardless of the caller's own desired set --
        // the provider's rules panel cannot silently free a held/locked
        // slot out from under a client.
        continue;
      }

      if (desired.has(slot.startsAt)) {
        // Kept: clear a stale withdrawal if this exact start time is being
        // saved again.
        if (slot.withdrawnAt !== null) {
          tx.update(availabilitySlots).set({ withdrawnAt: null }).where(eq(availabilitySlots.id, slot.id)).run();
        }
        continue;
      }

      // Removed, and not actively booked -- delete if nothing references
      // it at all; otherwise (an inactive booking still points at it) mark
      // it withdrawn, since the foreign key refuses the delete.
      if (bookingsForSlot.length === 0) {
        tx.delete(availabilitySlots).where(eq(availabilitySlots.id, slot.id)).run();
      } else if (slot.withdrawnAt === null) {
        tx.update(availabilitySlots).set({ withdrawnAt: now }).where(eq(availabilitySlots.id, slot.id)).run();
      }
    }

    for (const startsAt of uniqueSorted) {
      tx.insert(availabilitySlots)
        .values({ id: randomUUID(), providerProfileId, startsAt, createdAt })
        .onConflictDoNothing()
        .run();
    }
  });
}
