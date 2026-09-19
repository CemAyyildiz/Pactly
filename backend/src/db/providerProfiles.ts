import { and, count, eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { providerProfiles } from "./schema.js";

export type ProviderProfileRow = typeof providerProfiles.$inferSelect;

export interface NewProviderProfile {
  id: string;
  walletAddress: string;
  categoryId: string;
  /** Story 3.1: defaults to `''` only for a caller that does not supply
   * one (existing tests) -- a real profile (application decision, demo
   * seed) always sets these three. */
  displayName?: string;
  title?: string;
  location?: string;
  bio?: string;
  languages?: string[];
  sessionFormat: string;
  sessionLengthMinutes: number;
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
  isApproved?: boolean;
  createdAt: number;
}

export async function insertProviderProfile(db: Db, values: NewProviderProfile): Promise<void> {
  await db.insert(providerProfiles).values({
    id: values.id,
    walletAddress: values.walletAddress,
    categoryId: values.categoryId,
    displayName: values.displayName ?? "",
    title: values.title ?? "",
    location: values.location ?? "",
    bio: values.bio ?? "",
    languages: JSON.stringify(values.languages ?? []),
    sessionFormat: values.sessionFormat,
    sessionLengthMinutes: values.sessionLengthMinutes,
    priceAmount: values.priceAmount,
    depositRateBps: values.depositRateBps,
    cancellationWindowHours: values.cancellationWindowHours,
    isApproved: values.isApproved ?? false,
    createdAt: values.createdAt,
  });
}

export async function getProviderProfileById(db: Db, id: string): Promise<ProviderProfileRow | undefined> {
  const rows = await db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).limit(1);
  return rows[0];
}

export async function getProviderProfileByWallet(db: Db, walletAddress: string): Promise<ProviderProfileRow | undefined> {
  const rows = await db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.walletAddress, walletAddress))
    .limit(1);
  return rows[0];
}

/** Approved profiles only -- an unapproved profile must appear in neither
 * marketplace listings nor search (PRD Story 4.1 AC4). */
export async function listApprovedProviderProfiles(db: Db, categoryId?: string): Promise<ProviderProfileRow[]> {
  if (categoryId) {
    return db
      .select()
      .from(providerProfiles)
      .where(and(eq(providerProfiles.isApproved, true), eq(providerProfiles.categoryId, categoryId)));
  }
  return db.select().from(providerProfiles).where(eq(providerProfiles.isApproved, true));
}

/** Story 3.2's `GET /categories` extension: `providerCount` per category,
 * counting only approved profiles (AC1). One grouped query rather than a
 * per-category count. A category with zero approved providers is simply
 * absent from the map -- callers read it with `?? 0`. */
export async function countApprovedProvidersByCategory(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ categoryId: providerProfiles.categoryId, providerCount: count() })
    .from(providerProfiles)
    .where(eq(providerProfiles.isApproved, true))
    .groupBy(providerProfiles.categoryId);
  return new Map(rows.map((row) => [row.categoryId, row.providerCount]));
}

export interface ProviderRulesValues {
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
}

/** `services/profile.ts`'s `updateProviderRules` write path -- the one
 * place a signed-in provider's own `priceAmount`/`depositRateBps`/
 * `cancellationWindowHours` are updated after their profile is created.
 * The only other writer of these columns is `seed/demo.ts`'s upsert, which
 * writes its own hardcoded dev-only demo data directly via Drizzle rather
 * than through this function; a real provider's rules only ever change
 * through this path. Throws if `id` matches no row, rather than silently
 * writing nothing (same discipline as `db/bookings.ts`'s state writers). */
export async function updateProviderProfileRules(db: Db, id: string, values: ProviderRulesValues): Promise<void> {
  const result = await db
    .update(providerProfiles)
    .set({
      priceAmount: values.priceAmount,
      depositRateBps: values.depositRateBps,
      cancellationWindowHours: values.cancellationWindowHours,
    })
    .where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}
