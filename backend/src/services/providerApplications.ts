/**
 * Story 4.1/4.2: a professional applies to list their shop, an admin
 * decides. Thin over `../db/providerApplications.ts` and
 * `../db/providerProfiles.ts`; no SQL lives here.
 *
 * The profile row is created *at application time*, unapproved, so the
 * applicant can already open their panel and set price and slots while
 * the admin decides (the panel's own "pending approval" banner covers
 * Story 4.1 AC5). It never appears in listings or search until
 * `isApproved` flips (AC4 -- enforced by every read in
 * `db/providerProfiles.ts`, not here). Approving flips that one bit;
 * rejecting records a reason and leaves the row unapproved, so the same
 * wallet can apply again with corrected details.
 */
import { randomUUID } from "node:crypto";

import { getCategoryById, type CategoryRow } from "../db/categories.js";
import type { Db } from "../db/client.js";
import {
  decideProviderApplication,
  getLatestProviderApplicationByWallet,
  getProviderApplicationById,
  insertProviderApplication,
  listPendingProviderApplications,
  type ProviderApplicationRow,
} from "../db/providerApplications.js";
import {
  getProviderProfileByWallet,
  insertProviderProfile,
  setProviderProfileApproved,
  updateProviderProfileFromApplication,
} from "../db/providerProfiles.js";
import type { ProviderApplicationState } from "../db/schema.js";
import { computeDepositAmount, validateProviderRules } from "./profile.js";

const ASSET = "USDC";

export const SESSION_FORMATS = ["in_person", "video"] as const;
const MIN_SESSION_LENGTH_MINUTES = 15;
const MAX_SESSION_LENGTH_MINUTES = 240;
const MAX_SHORT_TEXT = 80;
const MAX_LOCATION = 120;
const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 600;
const MAX_REJECTION_REASON = 400;

export class InvalidProviderApplicationError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("One or more application values are invalid.");
    this.name = "InvalidProviderApplicationError";
    this.details = details;
  }
}

export class ProviderApplicationPendingError extends Error {
  constructor() {
    super("This wallet already has an application waiting for a decision.");
    this.name = "ProviderApplicationPendingError";
  }
}

export class AlreadyAProviderError extends Error {
  constructor() {
    super("This wallet is already listed as a provider.");
    this.name = "AlreadyAProviderError";
  }
}

export class NoProviderApplicationError extends Error {
  constructor() {
    super("This wallet has not applied yet.");
    this.name = "NoProviderApplicationError";
  }
}

export class ProviderApplicationNotFoundError extends Error {
  constructor() {
    super("No application was found with that id.");
    this.name = "ProviderApplicationNotFoundError";
  }
}

export class ProviderApplicationDecidedError extends Error {
  constructor() {
    super("This application has already been decided.");
    this.name = "ProviderApplicationDecidedError";
  }
}

export interface ProviderApplicationInput {
  name: string;
  title: string;
  categoryId: string;
  location: string;
  serviceDescription: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  /** Integer string, smallest unit (AD-7). */
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Field -> message map; empty means valid. Never throws. The three money
 * rules reuse `validateProviderRules` so an application can never accept
 * a price/deposit/window the panel's own form would refuse. */
export function validateProviderApplication(input: ProviderApplicationInput): Record<string, string> {
  const details: Record<string, string> = { ...validateProviderRules(input) };

  if (cleanText(input.name).length < 2 || cleanText(input.name).length > MAX_SHORT_TEXT) {
    details.name = `Name must be between 2 and ${MAX_SHORT_TEXT} characters.`;
  }
  if (cleanText(input.title).length < 2 || cleanText(input.title).length > MAX_SHORT_TEXT) {
    details.title = `Title must be between 2 and ${MAX_SHORT_TEXT} characters.`;
  }
  if (cleanText(input.location).length < 2 || cleanText(input.location).length > MAX_LOCATION) {
    details.location = `Location must be between 2 and ${MAX_LOCATION} characters.`;
  }
  const description = cleanText(input.serviceDescription);
  if (description.length < MIN_DESCRIPTION || description.length > MAX_DESCRIPTION) {
    details.serviceDescription = `Describe the service in ${MIN_DESCRIPTION} to ${MAX_DESCRIPTION} characters.`;
  }
  if (!(SESSION_FORMATS as readonly string[]).includes(input.sessionFormat)) {
    details.sessionFormat = `Session format must be one of ${SESSION_FORMATS.join(", ")}.`;
  }
  if (
    typeof input.sessionLengthMinutes !== "number" ||
    !Number.isInteger(input.sessionLengthMinutes) ||
    input.sessionLengthMinutes < MIN_SESSION_LENGTH_MINUTES ||
    input.sessionLengthMinutes > MAX_SESSION_LENGTH_MINUTES
  ) {
    details.sessionLengthMinutes = `Session length must be a whole number of minutes between ${MIN_SESSION_LENGTH_MINUTES} and ${MAX_SESSION_LENGTH_MINUTES}.`;
  }
  if (typeof input.categoryId !== "string" || input.categoryId.length === 0) {
    details.categoryId = "Pick a category.";
  }

  return details;
}

export interface ProviderApplicationView {
  id: string;
  state: ProviderApplicationState;
  name: string;
  title: string;
  category: { id: string; name: string; slug: string };
  serviceDescription: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: { amount: string; asset: string };
  deposit: { amount: string; asset: string };
  depositRateBps: number;
  cancellationWindowHours: number;
  rejectionReason: string | null;
  /** UTC epoch milliseconds, like every `createdAt` in the schema. */
  createdAt: number;
  decisionAt: number | null;
  /** The applicant's own profile id -- exists from the moment they apply. */
  profileId: string | null;
}

/** The admin queue's row: the applicant's view plus who is asking. */
export interface AdminProviderApplicationView extends ProviderApplicationView {
  walletAddress: string;
}

async function buildView(db: Db, row: ProviderApplicationRow, category: CategoryRow): Promise<ProviderApplicationView> {
  const profile = await getProviderProfileByWallet(db, row.walletAddress);
  return {
    id: row.id,
    state: row.state,
    name: row.name,
    title: row.title,
    category: { id: category.id, name: category.name, slug: category.slug },
    serviceDescription: row.serviceDescription,
    sessionFormat: row.sessionFormat,
    sessionLengthMinutes: row.sessionLengthMinutes,
    price: { amount: row.sessionPriceAmount, asset: ASSET },
    deposit: { amount: computeDepositAmount(row.sessionPriceAmount, row.depositRateBps), asset: ASSET },
    depositRateBps: row.depositRateBps,
    cancellationWindowHours: row.cancellationWindowHours,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    decisionAt: row.decisionAt,
    profileId: profile?.id ?? null,
  };
}

async function categoryForRow(db: Db, row: ProviderApplicationRow): Promise<CategoryRow> {
  const category = await getCategoryById(db, row.categoryId);
  if (!category) {
    // Unreachable in practice (`category_id` is a foreign key); guarded
    // rather than assumed, like `services/profile.ts`'s own reads.
    throw new ProviderApplicationNotFoundError();
  }
  return category;
}

/** `POST /me/provider/application`: validates, refuses a second live
 * application or an already-listed wallet, then records the application
 * and creates (or, after a rejection, rewrites) the unapproved profile. */
export async function applyAsProvider(db: Db, walletAddress: string, input: ProviderApplicationInput): Promise<ProviderApplicationView> {
  const details = validateProviderApplication(input);
  if (Object.keys(details).length === 0) {
    const category = await getCategoryById(db, input.categoryId);
    if (!category) {
      details.categoryId = "Pick a category.";
    }
  }
  if (Object.keys(details).length > 0) {
    throw new InvalidProviderApplicationError(details);
  }

  const latest = await getLatestProviderApplicationByWallet(db, walletAddress);
  if (latest?.state === "pending") {
    throw new ProviderApplicationPendingError();
  }
  const existingProfile = await getProviderProfileByWallet(db, walletAddress);
  if (existingProfile?.isApproved || latest?.state === "approved") {
    throw new AlreadyAProviderError();
  }

  const now = Date.now();
  const profileValues = {
    categoryId: input.categoryId,
    displayName: cleanText(input.name),
    title: cleanText(input.title),
    location: cleanText(input.location),
    bio: cleanText(input.serviceDescription),
    sessionFormat: input.sessionFormat,
    sessionLengthMinutes: input.sessionLengthMinutes,
    priceAmount: input.priceAmount,
    depositRateBps: input.depositRateBps,
    cancellationWindowHours: input.cancellationWindowHours,
  };
  if (existingProfile) {
    await updateProviderProfileFromApplication(db, existingProfile.id, profileValues);
  } else {
    await insertProviderProfile(db, { id: randomUUID(), walletAddress, ...profileValues, isApproved: false, createdAt: now });
  }

  const id = randomUUID();
  await insertProviderApplication(db, {
    id,
    walletAddress,
    name: profileValues.displayName,
    title: profileValues.title,
    categoryId: input.categoryId,
    serviceDescription: profileValues.bio,
    sessionFormat: input.sessionFormat,
    sessionLengthMinutes: input.sessionLengthMinutes,
    sessionPriceAmount: input.priceAmount,
    depositRateBps: input.depositRateBps,
    cancellationWindowHours: input.cancellationWindowHours,
    createdAt: now,
  });
  const row = (await getProviderApplicationById(db, id))!;
  return buildView(db, row, await categoryForRow(db, row));
}

/** `GET /me/provider/application`: the caller's newest application. */
export async function getOwnProviderApplication(db: Db, walletAddress: string): Promise<ProviderApplicationView> {
  const row = await getLatestProviderApplicationByWallet(db, walletAddress);
  if (!row) {
    throw new NoProviderApplicationError();
  }
  return buildView(db, row, await categoryForRow(db, row));
}

/** `GET /admin/applications`: every pending application, oldest first. */
export async function listPendingApplications(db: Db): Promise<AdminProviderApplicationView[]> {
  const rows = await listPendingProviderApplications(db);
  const views: AdminProviderApplicationView[] = [];
  for (const row of rows) {
    views.push({ ...(await buildView(db, row, await categoryForRow(db, row))), walletAddress: row.walletAddress });
  }
  return views;
}

export type ProviderApplicationOutcome = "approve" | "reject";

/** `POST /admin/applications/:id/decide`. Approving puts the applicant's
 * profile on the marketplace immediately (Story 4.2 AC3); rejecting needs
 * a reason (AC2) and leaves the profile unapproved. */
export async function decideApplication(
  db: Db,
  id: string,
  outcome: ProviderApplicationOutcome,
  adminWallet: string,
  reason?: string,
): Promise<AdminProviderApplicationView> {
  const row = await getProviderApplicationById(db, id);
  if (!row) {
    throw new ProviderApplicationNotFoundError();
  }
  if (row.state !== "pending") {
    throw new ProviderApplicationDecidedError();
  }
  const cleanReason = cleanText(reason);
  if (outcome === "reject" && (cleanReason.length === 0 || cleanReason.length > MAX_REJECTION_REASON)) {
    throw new InvalidProviderApplicationError({ reason: `Give the applicant a reason (1 to ${MAX_REJECTION_REASON} characters).` });
  }

  const profile = await getProviderProfileByWallet(db, row.walletAddress);
  if (outcome === "approve") {
    if (!profile) {
      // The profile is created at application time; a missing one means
      // the database was edited by hand. Refuse rather than approve a
      // listing that cannot exist.
      throw new ProviderApplicationNotFoundError();
    }
    await setProviderProfileApproved(db, profile.id, true);
  }

  const decided = await decideProviderApplication(db, id, {
    state: outcome === "approve" ? "approved" : "rejected",
    decisionByWallet: adminWallet,
    decisionAt: Date.now(),
    rejectionReason: outcome === "reject" ? cleanReason : undefined,
  });
  if (!decided) {
    throw new ProviderApplicationDecidedError();
  }
  const updated = (await getProviderApplicationById(db, id))!;
  return { ...(await buildView(db, updated, await categoryForRow(db, updated))), walletAddress: updated.walletAddress };
}
