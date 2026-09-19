/**
 * Provider profile service functions later stories' routes call. Thin over
 * `../db/providerProfiles.ts` and `../db/availabilitySlots.ts`; no SQL
 * lives here.
 *
 * Story 3.1 adds: the deposit computation (`computeDepositAmount`), the
 * bounds validation for the rules and availability forms (the spec's I/O
 * matrix), a single view builder both `GET /providers/:id` and
 * `GET /me/provider` share, and the four typed errors those routes
 * translate into the `{code, message, details?}` envelope -- the same
 * "typed error, never a raw one" discipline `services/booking.ts` and
 * `auth/challenge.ts` already follow.
 */
import { randomUUID } from "node:crypto";

import {
  getProviderProfileById,
  getProviderProfileByWallet,
  insertProviderProfile,
  listApprovedProviderProfiles,
  updateProviderProfileRules,
  type ProviderProfileRow,
} from "../db/providerProfiles.js";
import { listFutureSlots, replaceFutureSlots, type AvailabilitySlotRow } from "../db/availabilitySlots.js";
import { getCategoryById, type CategoryRow } from "../db/categories.js";
import type { Db } from "../db/client.js";

/** Pactly's only supported asset for now (matches `services/booking.ts`'s
 * own `DEPOSIT_ASSET_SYMBOL`). Every amount this module returns is shaped
 * `{ amount, asset }` per AD-7/AD-11 -- an integer string, never a float. */
const ASSET = "USDC";

export interface CreateProviderProfileInput {
  walletAddress: string;
  categoryId: string;
  displayName?: string;
  title?: string;
  location?: string;
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
    displayName: input.displayName,
    title: input.title,
    location: input.location,
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

// ---------------------------------------------------------------------------
// Story 3.1: deposit math, validation, the shared view, and the four routes'
// service functions.
// ---------------------------------------------------------------------------

/** `floor(price * depositRateBps / 10000)`, in BigInt so an i128-sized price
 * never loses precision (AD-7) -- computed once here and never
 * recomputed by the frontend (the spec's own "Always" rule). BigInt
 * division on two non-negative operands truncates toward zero, which is
 * exactly `floor` for this domain. */
export function computeDepositAmount(priceAmount: string, depositRateBps: number): string {
  const price = BigInt(priceAmount);
  const bps = BigInt(depositRateBps);
  return ((price * bps) / 10000n).toString();
}

export class ProviderNotFoundError extends Error {
  constructor(message = "No provider was found with that id.") {
    super(message);
    this.name = "ProviderNotFoundError";
  }
}

export class NotAProviderError extends Error {
  constructor(message = "This wallet does not own a provider profile.") {
    super(message);
    this.name = "NotAProviderError";
  }
}

export class InvalidProviderRulesError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("One or more rule values are invalid.");
    this.name = "InvalidProviderRulesError";
    this.details = details;
  }
}

export class InvalidAvailabilitySlotsError extends Error {
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("One or more slot values are invalid.");
    this.name = "InvalidAvailabilitySlotsError";
    this.details = details;
  }
}

export interface ProviderRulesInput {
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
}

const POSITIVE_INTEGER_STRING = /^[1-9]\d*$/;
const MIN_DEPOSIT_RATE_BPS = 1;
const MAX_DEPOSIT_RATE_BPS = 10000;
const MIN_CANCELLATION_WINDOW_HOURS = 0;
const MAX_CANCELLATION_WINDOW_HOURS = 720;

/** The rules form's bounds (the spec's I/O matrix). Returns a field ->
 * message map; empty means valid. Never throws -- the caller decides what
 * to do with an invalid result (the route wraps it in
 * {@link InvalidProviderRulesError}, a test can assert on the map
 * directly). */
export function validateProviderRules(input: ProviderRulesInput): Record<string, string> {
  const details: Record<string, string> = {};

  if (typeof input.priceAmount !== "string" || !POSITIVE_INTEGER_STRING.test(input.priceAmount)) {
    details.priceAmount = "Price must be a positive integer string, in USDC's smallest unit.";
  }
  if (
    typeof input.depositRateBps !== "number" ||
    !Number.isInteger(input.depositRateBps) ||
    input.depositRateBps < MIN_DEPOSIT_RATE_BPS ||
    input.depositRateBps > MAX_DEPOSIT_RATE_BPS
  ) {
    details.depositRateBps = `Deposit rate must be a whole number of basis points between ${MIN_DEPOSIT_RATE_BPS} and ${MAX_DEPOSIT_RATE_BPS}.`;
  }
  if (
    typeof input.cancellationWindowHours !== "number" ||
    !Number.isInteger(input.cancellationWindowHours) ||
    input.cancellationWindowHours < MIN_CANCELLATION_WINDOW_HOURS ||
    input.cancellationWindowHours > MAX_CANCELLATION_WINDOW_HOURS
  ) {
    details.cancellationWindowHours = `Cancellation window must be a whole number of hours between ${MIN_CANCELLATION_WINDOW_HOURS} and ${MAX_CANCELLATION_WINDOW_HOURS}.`;
  }

  // Only checked once the two inputs it depends on are themselves valid --
  // otherwise `computeDepositAmount` could be handed a non-numeric string.
  if (details.priceAmount === undefined && details.depositRateBps === undefined) {
    const deposit = computeDepositAmount(input.priceAmount, input.depositRateBps);
    if (BigInt(deposit) <= 0n) {
      details.depositRateBps = "The deposit would round to zero. Raise the price or the deposit rate.";
    }
  }

  return details;
}

const SLOT_BOUNDARY_SECONDS = 15 * 60;
const MAX_FUTURE_SLOTS = 500;
const MAX_DAYS_AHEAD = 60;
const PUBLIC_SLOTS_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** The availability grid's bounds (the spec's I/O matrix): every slot must
 * be in the future, at most 60 days out, on a 15-minute boundary, and not
 * overlap another within `sessionLengthMinutes`; at most 500 slots total.
 * Returns a details object naming the offending values -- empty means
 * valid. */
export function validateAvailabilitySlots(
  slots: number[],
  sessionLengthMinutes: number,
  now: number = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  if (slots.length > MAX_FUTURE_SLOTS) {
    details.count = `At most ${MAX_FUTURE_SLOTS} slots may be saved at once (received ${slots.length}).`;
  }

  const maxStartsAt = now + MAX_DAYS_AHEAD * 24 * 60 * 60;
  const invalid = slots.filter(
    (slot) =>
      !Number.isInteger(slot) || slot <= now || slot > maxStartsAt || slot % SLOT_BOUNDARY_SECONDS !== 0,
  );
  if (invalid.length > 0) {
    details.invalid = invalid;
  }

  const sessionSeconds = sessionLengthMinutes * 60;
  const sorted = [...new Set(slots)].sort((a, b) => a - b);
  const overlapping: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (current - previous < sessionSeconds) {
      overlapping.push(current);
    }
  }
  if (overlapping.length > 0) {
    details.overlapping = overlapping;
  }

  return details;
}

export interface ProviderProfileView {
  id: string;
  displayName: string;
  title: string;
  category: { id: string; name: string; slug: string };
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: { amount: string; asset: string };
  deposit: { amount: string; asset: string };
  depositRateBps: number;
  cancellationWindowHours: number;
  verifiedSessionCount: number;
  isApproved: boolean;
  /** UTC epoch seconds, ascending. */
  slots: number[];
}

/** The one place a `ProviderProfileRow` becomes an HTTP response -- shared
 * by `GET /providers/:id` and `GET /me/provider` so the two routes can
 * never drift into different shapes or a different deposit formula. */
export function buildProviderProfileView(
  profile: ProviderProfileRow,
  category: CategoryRow,
  slots: AvailabilitySlotRow[],
): ProviderProfileView {
  return {
    id: profile.id,
    displayName: profile.displayName,
    title: profile.title,
    category: { id: category.id, name: category.name, slug: category.slug },
    location: profile.location,
    sessionFormat: profile.sessionFormat,
    sessionLengthMinutes: profile.sessionLengthMinutes,
    price: { amount: profile.priceAmount, asset: ASSET },
    deposit: { amount: computeDepositAmount(profile.priceAmount, profile.depositRateBps), asset: ASSET },
    depositRateBps: profile.depositRateBps,
    cancellationWindowHours: profile.cancellationWindowHours,
    verifiedSessionCount: profile.verifiedSessionCount,
    isApproved: profile.isApproved,
    slots: slots.map((slot) => slot.startsAt),
  };
}

async function loadCategoryOrThrow(db: Db, categoryId: string, notFound: () => Error): Promise<CategoryRow> {
  const category = await getCategoryById(db, categoryId);
  if (!category) {
    // Unreachable in practice: `category_id` is a foreign key, so a
    // profile can never reference a category that does not exist. Guarded
    // anyway rather than assumed (same discipline as
    // `auth/challenge.ts`'s `challengeNonce`).
    throw notFound();
  }
  return category;
}

/** `GET /providers/:id`: an approved profile's public view, with only the
 * next 30 days of future slots (the I/O matrix). An unapproved or unknown
 * id is indistinguishable -- both throw {@link ProviderNotFoundError} --
 * so nothing about an unapproved profile ever leaks (the spec's own
 * "Always" rule). */
export async function getPublicProviderProfile(
  db: Db,
  id: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileById(db, id);
  if (!profile || !profile.isApproved) {
    throw new ProviderNotFoundError();
  }
  const category = await loadCategoryOrThrow(db, profile.categoryId, () => new ProviderNotFoundError());
  const slots = await listFutureSlots(db, profile.id, { now, withinSeconds: PUBLIC_SLOTS_WINDOW_SECONDS });
  return buildProviderProfileView(profile, category, slots);
}

/** `GET /me/provider`: the caller's own profile, including while
 * unapproved, plus every future slot (no 30-day cap -- that cap is a
 * public-facing courtesy, not a limit on what a provider can plan). */
export async function getOwnProviderProfile(
  db: Db,
  walletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const category = await loadCategoryOrThrow(db, profile.categoryId, () => new NotAProviderError());
  const slots = await listFutureSlots(db, profile.id, { now });
  return buildProviderProfileView(profile, category, slots);
}

/** `PUT /me/provider/rules`: validates, saves, and returns the updated own
 * profile (with the recomputed deposit) -- nothing is saved when
 * validation fails. */
export async function updateProviderRules(
  db: Db,
  walletAddress: string,
  input: ProviderRulesInput,
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const details = validateProviderRules(input);
  if (Object.keys(details).length > 0) {
    throw new InvalidProviderRulesError(details);
  }
  await updateProviderProfileRules(db, profile.id, input);
  return getOwnProviderProfile(db, walletAddress);
}

/** `PUT /me/provider/availability`: validates against the caller's own
 * `sessionLengthMinutes`, replaces every future slot, and returns the
 * updated own profile -- nothing is saved when validation fails. */
export async function updateProviderAvailability(
  db: Db,
  walletAddress: string,
  slots: number[],
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const details = validateAvailabilitySlots(slots, profile.sessionLengthMinutes, now);
  if (Object.keys(details).length > 0) {
    throw new InvalidAvailabilitySlotsError(details);
  }
  await replaceFutureSlots(db, profile.id, slots, now);
  return getOwnProviderProfile(db, walletAddress, now);
}
