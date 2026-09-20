import { asc, desc, and, eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { providerApplications, type ProviderApplicationState } from "./schema.js";

export type ProviderApplicationRow = typeof providerApplications.$inferSelect;

export interface NewProviderApplication {
  id: string;
  walletAddress: string;
  name: string;
  title: string;
  categoryId: string;
  serviceDescription: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  /** Integer string, smallest unit (AD-7). */
  sessionPriceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
  createdAt: number;
}

export async function insertProviderApplication(db: Db, values: NewProviderApplication): Promise<void> {
  await db.insert(providerApplications).values({ ...values, state: "pending" });
}

export async function getProviderApplicationById(db: Db, id: string): Promise<ProviderApplicationRow | undefined> {
  const rows = await db.select().from(providerApplications).where(eq(providerApplications.id, id)).limit(1);
  return rows[0];
}

/** A wallet may apply again after a rejection, so "its application" is
 * always the newest one. */
export async function getLatestProviderApplicationByWallet(
  db: Db,
  walletAddress: string,
): Promise<ProviderApplicationRow | undefined> {
  const rows = await db
    .select()
    .from(providerApplications)
    .where(eq(providerApplications.walletAddress, walletAddress))
    .orderBy(desc(providerApplications.createdAt), desc(providerApplications.id))
    .limit(1);
  return rows[0];
}

/** Oldest first -- the admin queue is a queue. */
export async function listPendingProviderApplications(db: Db): Promise<ProviderApplicationRow[]> {
  return db
    .select()
    .from(providerApplications)
    .where(eq(providerApplications.state, "pending"))
    .orderBy(asc(providerApplications.createdAt), asc(providerApplications.id));
}

export interface ProviderApplicationDecision {
  state: Exclude<ProviderApplicationState, "pending">;
  decisionByWallet: string;
  decisionAt: number;
  rejectionReason?: string;
}

/** Records a decision on a still-pending application only; returns `false`
 * when the row was already decided (or does not exist), so a second admin
 * click can never overwrite the first decision. */
export async function decideProviderApplication(db: Db, id: string, decision: ProviderApplicationDecision): Promise<boolean> {
  const result = await db
    .update(providerApplications)
    .set({
      state: decision.state,
      decisionByWallet: decision.decisionByWallet,
      decisionAt: decision.decisionAt,
      rejectionReason: decision.rejectionReason ?? null,
    })
    .where(and(eq(providerApplications.id, id), eq(providerApplications.state, "pending")));
  return result.changes > 0;
}
