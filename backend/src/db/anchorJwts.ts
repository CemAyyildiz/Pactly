/**
 * The only place SQL touches the `anchor_jwts` table -- the anchor JWT
 * cache `../services/auth.ts` reads before ever running the anchor's real
 * SEP-10 exchange (`../anchor/sep10.ts`).
 */
import { eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { anchorJwts } from "./schema.js";

export type AnchorJwtRow = typeof anchorJwts.$inferSelect;

export async function getAnchorJwt(db: Db, walletAddress: string): Promise<AnchorJwtRow | undefined> {
  const rows = await db.select().from(anchorJwts).where(eq(anchorJwts.walletAddress, walletAddress)).limit(1);
  return rows[0];
}

export interface UpsertAnchorJwt {
  walletAddress: string;
  jwt: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  updatedAt?: number;
}

/** Writes (or replaces) the cached anchor JWT for one wallet. A second
 * exchange for the same wallet replaces the row in place -- there is never
 * more than one cached anchor JWT per wallet. */
export async function upsertAnchorJwt(db: Db, values: UpsertAnchorJwt): Promise<void> {
  const updatedAt = values.updatedAt ?? Date.now();
  await db
    .insert(anchorJwts)
    .values({ walletAddress: values.walletAddress, jwt: values.jwt, expiresAt: values.expiresAt, updatedAt })
    .onConflictDoUpdate({
      target: anchorJwts.walletAddress,
      set: { jwt: values.jwt, expiresAt: values.expiresAt, updatedAt },
    });
}
