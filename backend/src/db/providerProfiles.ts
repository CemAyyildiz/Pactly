import { and, eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { providerProfiles } from "./schema.js";

export type ProviderProfileRow = typeof providerProfiles.$inferSelect;

export interface NewProviderProfile {
  id: string;
  walletAddress: string;
  categoryId: string;
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
