/**
 * The event worker's stored cursor (AD-9): a single row (`id = 1`) in
 * `event_worker_state`. `../chain/event-worker.ts` reads it before each run
 * and writes it back after, so a restart resumes after the cursor instead
 * of at the beginning.
 */
import { eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { eventWorkerState } from "./schema.js";

const SINGLETON_ID = 1;

/** `undefined` before the worker has ever run (no row yet) or when the one
 * row's `cursor` is `null` (the worker ran but has not advanced past the
 * start -- the same "begin from the top" case as never having run). */
export async function getCursor(db: Db): Promise<string | undefined> {
  const rows = await db
    .select()
    .from(eventWorkerState)
    .where(eq(eventWorkerState.id, SINGLETON_ID))
    .limit(1);
  return rows[0]?.cursor ?? undefined;
}

export async function setCursor(db: Db, cursor: string, now: number = Date.now()): Promise<void> {
  await db
    .insert(eventWorkerState)
    .values({ id: SINGLETON_ID, cursor, updatedAt: now })
    .onConflictDoUpdate({
      target: eventWorkerState.id,
      set: { cursor, updatedAt: now },
    });
}
