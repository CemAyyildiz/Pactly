/**
 * The only place SQL touches the `availability_slots` table (Story 3.1).
 * Slots are concrete UTC-epoch-second rows, not a recurring rule -- see
 * `schema.ts`'s own comment on why, and the story's Design Notes ("Why
 * concrete slots, not weekly rules").
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, lte } from "drizzle-orm";

import type { Db } from "./client.js";
import { availabilitySlots } from "./schema.js";

export type AvailabilitySlotRow = typeof availabilitySlots.$inferSelect;

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

/**
 * Replaces every *future* slot for `providerProfileId` with `slots`
 * (deduplicated and sorted) in one transaction -- delete the future rows,
 * then insert the new set, so a reader (or a concurrent save) never
 * observes a half-replaced table. Past slots (`startsAt <= now`) are left
 * exactly as they are: no booking references a slot yet (Story 3.4 adds
 * that), so replacing every future slot on every save is safe for now, but
 * a past row is never this function's business either way.
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
    tx.delete(availabilitySlots)
      .where(and(eq(availabilitySlots.providerProfileId, providerProfileId), gt(availabilitySlots.startsAt, now)))
      .run();
    for (const startsAt of uniqueSorted) {
      tx.insert(availabilitySlots).values({ id: randomUUID(), providerProfileId, startsAt, createdAt }).run();
    }
  });
}
