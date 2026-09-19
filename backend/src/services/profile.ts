/**
 * Provider profile service functions later stories' routes call. Thin over
 * `../db/providerProfiles.ts`; no SQL lives here.
 */
import { randomUUID } from "node:crypto";

import {
  getProviderProfileById,
  getProviderProfileByWallet,
  insertProviderProfile,
  listApprovedProviderProfiles,
  type ProviderProfileRow,
} from "../db/providerProfiles.js";
import { getCategoryById } from "../db/categories.js";
import type { Db } from "../db/client.js";

export interface CreateProviderProfileInput {
  walletAddress: string;
  categoryId: string;
  bio?: string;
  languages?: string[];
  sessionFormat: string;
  sessionLengthMinutes: number;
  /** Integer string, smallest unit (AD-7). */
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
  /** Story 4.1/4.2 decide this later; a profile this story creates is
   * unapproved by default so it never appears in listings or search until
   * an admin approves the application it belongs to. */
  isApproved?: boolean;
  id?: string;
}

export async function createProviderProfile(db: Db, input: CreateProviderProfileInput): Promise<string> {
  const category = await getCategoryById(db, input.categoryId);
  if (!category) {
    throw new TypeError(`No category exists with id "${input.categoryId}"`);
  }
  const id = input.id ?? randomUUID();
  await insertProviderProfile(db, {
    id,
    walletAddress: input.walletAddress,
    categoryId: input.categoryId,
    bio: input.bio,
    languages: input.languages,
    sessionFormat: input.sessionFormat,
    sessionLengthMinutes: input.sessionLengthMinutes,
    priceAmount: input.priceAmount,
    depositRateBps: input.depositRateBps,
    cancellationWindowHours: input.cancellationWindowHours,
    isApproved: input.isApproved,
    createdAt: Date.now(),
  });
  return id;
}

export function getProfile(db: Db, id: string): Promise<ProviderProfileRow | undefined> {
  return getProviderProfileById(db, id);
}

export function getProfileByWallet(db: Db, walletAddress: string): Promise<ProviderProfileRow | undefined> {
  return getProviderProfileByWallet(db, walletAddress);
}

/** Only ever returns approved profiles -- the marketplace-listing rule
 * (PRD Story 4.1 AC4) enforced at the one place every discovery/search
 * route will call through. */
export function listMarketplaceProfiles(db: Db, categoryId?: string): Promise<ProviderProfileRow[]> {
  return listApprovedProviderProfiles(db, categoryId);
}
