/**
 * The only place SQL touches the `availability_slots` table (Story 3.1).
 * Slots are concrete UTC-epoch-second rows, not a recurring rule -- see
 * `schema.ts`'s own comment on why, and the story's Design Notes ("Why
 * concrete slots, not weekly rules").
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, exists, gt, gte, inArray, isNotNull, lt, lte, notExists, notInArray, or, sql } from "drizzle-orm";

import type { Db } from "./client.js";
import { availabilitySlots, bookings } from "./schema.js";

export type AvailabilitySlotRow = typeof availabilitySlots.$inferSelect;

/** Every slot for `providerProfileId` that currently carries an "active"
 * booking (Story 3.4, AD-13): a non-expired hold, or a booking whose
 * `escrowState` is non-null. Shared by {@link replaceFutureSlots} (which
 * must never delete or re-create one of these rows out from under a
 * client's own hold or lock) and the public/open-slot listings below
 * (which must never advertise one of these as bookable). */
function activeBookingForSlot(now: number) {
  return and(
    eq(bookings.slotId, availabilitySlots.id),
    or(isNotNull(bookings.escrowState), gt(bookings.holdExpiresAt, now)),
  );
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
  const conditions = [eq(availabilitySlots.providerProfileId, providerProfileId), gt(availabilitySlots.startsAt, now)];
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
    .where(and(eq(availabilitySlots.providerProfileId, providerProfileId), eq(availabilitySlots.startsAt, startsAt)))
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
        notExists(db.select({ one: sql`1` }).from(bookings).where(activeBookingForSlot(now))),
      ),
    )
    .orderBy(asc(availabilitySlots.startsAt));
  return rows.map((row) => row.startsAt);
}

/**
 * Replaces every *future* slot for `providerProfileId` with `slots`
 * (deduplicated and sorted) in one transaction -- delete the future rows,
 * then insert the new set, so a reader (or a concurrent save) never
 * observes a half-replaced table. Past slots (`startsAt <= now`) are left
 * exactly as they are.
 *
 * Story 3.4 amendment (the story's own Design Notes, "Why replace-all-future
 * on save" in Story 3.1 flagged this as 3.4's job): a future slot that now
 * carries an active booking (a non-expired hold, or a locked escrow) is
 * never deleted here, even when the caller's own `slots` array omits it --
 * a provider's rules panel has no notion of bookings, so it must not be
 * able to silently free an already-held or already-locked slot. Such a
 * slot is also never re-inserted a second time if the caller's `slots`
 * array happens to still include it (`onConflictDoNothing`), since the
 * unique `(providerProfileId, startsAt)` index would otherwise reject the
 * whole transaction.
 *
 * Synchronous end to end inside the `db.transaction()` callback, per
 * better-sqlite3's contract (see `db/bookings.ts`'s own comment on this) --
 * no `await` between the delete and the inserts.
 */
export async function replaceFutureSlots(
  db: Db,
  providerProfileId: string,
  slots: number[],
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const uniqueSorted = [...new Set(slots)].sort((a, b) => a - b);
  const createdAt = Date.now();
  db.transaction((tx) => {
    const protectedIds = tx
      .select({ id: availabilitySlots.id })
      .from(availabilitySlots)
      .where(
        and(
          eq(availabilitySlots.providerProfileId, providerProfileId),
          gt(availabilitySlots.startsAt, now),
          exists(tx.select({ one: sql`1` }).from(bookings).where(activeBookingForSlot(now))),
        ),
      )
      .all()
      .map((row) => row.id);

    tx.delete(availabilitySlots)
      .where(
        and(
          eq(availabilitySlots.providerProfileId, providerProfileId),
          gt(availabilitySlots.startsAt, now),
          protectedIds.length > 0 ? notInArray(availabilitySlots.id, protectedIds) : undefined,
        ),
      )
      .run();
    for (const startsAt of uniqueSorted) {
      tx.insert(availabilitySlots)
        .values({ id: randomUUID(), providerProfileId, startsAt, createdAt })
        .onConflictDoNothing()
        .run();
    }
  });
}
