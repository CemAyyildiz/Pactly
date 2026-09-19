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
  countApprovedProvidersByCategory,
  getProviderProfileById,
  getProviderProfileByWallet,
  insertProviderProfile,
  listApprovedProviderProfiles,
  listApprovedProviderProfilesForDiscover,
  updateProviderProfileRules,
  type ProviderProfileRow,
} from "../db/providerProfiles.js";
import {
  listEarliestFutureSlotsByProvider,
  listFutureSlots,
  replaceFutureSlots,
  type AvailabilitySlotRow,
} from "../db/availabilitySlots.js";
import { getCategoryById, getCategoryBySlug, listCategories, type CategoryRow } from "../db/categories.js";
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

// ---------------------------------------------------------------------------
// Story 3.2: the Discover list's card objects and the category counts.
// ---------------------------------------------------------------------------

/** How many of a provider's earliest open slots a Discover card shows
 * (PRD 3.2 AC3, DESIGN.md's provider card). */
const CARD_EARLIEST_SLOTS_LIMIT = 3;

export interface ProviderCardView {
  id: string;
  displayName: string;
  title: string;
  category: { slug: string; name: string };
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: { amount: string; asset: string };
  deposit: { amount: string; asset: string };
  cancellationWindowHours: number;
  verifiedSessionCount: number;
  providerCancellationCount: number;
  /** UTC epoch seconds, ascending, at most {@link CARD_EARLIEST_SLOTS_LIMIT}. */
  earliestSlots: number[];
}

/** One approved profile's card shape (the I/O matrix's "List all" row) --
 * a narrower, differently-shaped sibling of {@link ProviderProfileView}
 * (no `depositRateBps`/`isApproved`/full `slots`; adds
 * `providerCancellationCount` and the capped `earliestSlots`), since the
 * Discover list and the profile page answer different questions. */
export function buildProviderCardView(
  profile: ProviderProfileRow,
  category: CategoryRow,
  earliestSlots: number[],
): ProviderCardView {
  return {
    id: profile.id,
    displayName: profile.displayName,
    title: profile.title,
    category: { slug: category.slug, name: category.name },
    location: profile.location,
    sessionFormat: profile.sessionFormat,
    sessionLengthMinutes: profile.sessionLengthMinutes,
    price: { amount: profile.priceAmount, asset: ASSET },
    deposit: { amount: computeDepositAmount(profile.priceAmount, profile.depositRateBps), asset: ASSET },
    cancellationWindowHours: profile.cancellationWindowHours,
    verifiedSessionCount: profile.verifiedSessionCount,
    providerCancellationCount: profile.providerCancellationCount,
    earliestSlots,
  };
}

/** Story 3.3's own availability windows (the I/O matrix's "Availability"
 * row): "at least one open future slot within 24h/7 days". */
const AVAILABILITY_WINDOW_SECONDS: Record<"24h" | "week", number> = {
  "24h": 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
};

export interface DiscoverFilters {
  /** Trimmed search text (AC1) -- matched against display name, title,
   * bio and category name, case-insensitively, by
   * `listApprovedProviderProfilesForDiscover`. */
  query?: string;
  /** Raw `sessionFormat` values (AC3) -- a profile matches if its own
   * `sessionFormat` is any one of these (OR, not AND: "the formats
   * present" is a multi-select). */
  formats?: string[];
  /** Integer strings, smallest unit (AD-7) -- compared as `BigInt` here,
   * never pushed into SQL (see `listApprovedProviderProfilesForDiscover`'s
   * own comment on why). */
  minPriceAmount?: string;
  maxPriceAmount?: string;
  /** Basis points, inclusive upper bound (AC3: "deposit rate (max %)"). */
  maxDepositRateBps?: number;
  /** `undefined` means "Any" -- the spec's own default, so no filtering at
   * all (the I/O matrix never mentions filtering out slotless providers
   * unless a window is actually chosen). */
  availability?: "24h" | "week";
}

/** `GET /providers[?category=<slug>&...]`: approved providers as card
 * objects (AC1 -- enforced by `listApprovedProviderProfilesForDiscover`,
 * never by filtering here), sorted by soonest open slot ascending; a
 * provider with no open slot sorts last, and ties (including "both
 * slotless") break by `displayName` (the spec's own "Always" sort rule,
 * unchanged from Story 3.2 -- Story 3.3 filters the input, never the
 * order). An unknown category slug returns an empty list, never an error
 * (the I/O matrix's own row) -- this is the one place a slug is resolved
 * to a category id for the list's own filter. */
export async function listDiscoverProviders(
  db: Db,
  categorySlug?: string,
  filters: DiscoverFilters = {},
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderCardView[]> {
  let categoryId: string | undefined;
  if (categorySlug !== undefined) {
    const category = await getCategoryBySlug(db, categorySlug);
    if (!category) {
      return [];
    }
    categoryId = category.id;
  }

  let profiles = await listApprovedProviderProfilesForDiscover(db, {
    categoryId,
    query: filters.query,
    formats: filters.formats,
  });
  if (profiles.length === 0) {
    return [];
  }

  // Money filters: BigInt comparisons over the SQL layer's already-
  // text/category/format-filtered rows (the I/O matrix's own "Price range"
  // and "Deposit cap" rows) -- app.ts has already dropped a non-integer or
  // out-of-bounds param, so every value reaching here is trusted.
  if (filters.minPriceAmount !== undefined || filters.maxPriceAmount !== undefined) {
    const min = filters.minPriceAmount !== undefined ? BigInt(filters.minPriceAmount) : undefined;
    const max = filters.maxPriceAmount !== undefined ? BigInt(filters.maxPriceAmount) : undefined;
    profiles = profiles.filter((profile) => {
      const price = BigInt(profile.priceAmount);
      if (min !== undefined && price < min) return false;
      if (max !== undefined && price > max) return false;
      return true;
    });
  }
  if (filters.maxDepositRateBps !== undefined) {
    const maxDepositRateBps = filters.maxDepositRateBps;
    profiles = profiles.filter((profile) => profile.depositRateBps <= maxDepositRateBps);
  }
  if (profiles.length === 0) {
    return [];
  }

  const allCategories = await listCategories(db);
  const categoryById = new Map(allCategories.map((row) => [row.id, row]));
  const earliestSlotsByProvider = await listEarliestFutureSlotsByProvider(
    db,
    profiles.map((profile) => profile.id),
    { now, limit: CARD_EARLIEST_SLOTS_LIMIT },
  );

  // Availability: a provider's *earliest* future slot is, by definition,
  // its closest one to `now` -- so "at least one open slot within the
  // window" reduces to just checking that single earliest value, never a
  // second query over every future slot.
  if (filters.availability !== undefined) {
    const windowSeconds = AVAILABILITY_WINDOW_SECONDS[filters.availability];
    profiles = profiles.filter((profile) => {
      const earliest = earliestSlotsByProvider.get(profile.id)?.[0];
      return earliest !== undefined && earliest <= now + windowSeconds;
    });
  }

  const cards = profiles.map((profile) => {
    const category = categoryById.get(profile.categoryId);
    if (!category) {
      // Unreachable in practice: `category_id` is a foreign key (see
      // `loadCategoryOrThrow`'s own comment on the same guarantee).
      throw new TypeError(`No category exists with id "${profile.categoryId}"`);
    }
    return buildProviderCardView(profile, category, earliestSlotsByProvider.get(profile.id) ?? []);
  });

  cards.sort((a, b) => {
    const aSlot = a.earliestSlots[0];
    const bSlot = b.earliestSlots[0];
    if (aSlot === undefined && bSlot === undefined) {
      return a.displayName.localeCompare(b.displayName);
    }
    if (aSlot === undefined) {
      return 1;
    }
    if (bSlot === undefined) {
      return -1;
    }
    if (aSlot !== bSlot) {
      return aSlot - bSlot;
    }
    return a.displayName.localeCompare(b.displayName);
  });

  return cards;
}

export interface CategoryWithProviderCount {
  id: string;
  name: string;
  slug: string;
  /** Approved providers in this category (AC1) -- never a raw application
   * or unapproved-profile count. */
  providerCount: number;
}

/** `GET /categories`: every category plus `providerCount` (Story 3.2's own
 * extension of Story 4.1's plain list). A category with no approved
 * provider still appears, with `providerCount: 0` -- the Discover rail
 * shows every category, not just the populated ones. */
export async function listCategoriesWithProviderCounts(db: Db): Promise<CategoryWithProviderCount[]> {
  const [allCategories, counts] = await Promise.all([listCategories(db), countApprovedProvidersByCategory(db)]);
  return allCategories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    providerCount: counts.get(category.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Story 3.3: search suggestions.
// ---------------------------------------------------------------------------

export type DiscoverSuggestionKind = "category" | "service" | "provider";

export interface DiscoverSuggestion {
  kind: DiscoverSuggestionKind;
  label: string;
  value: string;
  /** Approved providers picking this suggestion would return (the I/O
   * matrix's own "Suggestions" row) -- for a category, its
   * `providerCount`; for a service or provider name, how many approved
   * profiles share that exact title/display name. */
  count: number;
}

/** `q` shorter than this returns an empty list outright (the I/O matrix's
 * own "Suggestions" row) -- a single character is too broad to be useful
 * and would otherwise suggest almost everything. */
const MIN_SUGGESTION_QUERY_LENGTH = 2;
/** At most this many suggestions, across all three kinds combined (the
 * I/O matrix's own "Suggestions" row). */
const MAX_SUGGESTIONS = 8;

/** `GET /providers/suggest?q=`: up to {@link MAX_SUGGESTIONS} suggestions
 * grouped into categories, services (distinct provider titles) and
 * providers (display names), each carrying the approved-provider count
 * picking it would return (AC2). Matching is case-insensitive substring,
 * the same "good enough at demo scale" rule
 * `listApprovedProviderProfilesForDiscover` follows -- no separate search
 * index. A `q` shorter than two characters is an empty list, never an
 * error. */
export async function suggestDiscoverQueries(db: Db, rawQuery: string): Promise<DiscoverSuggestion[]> {
  const query = rawQuery.trim();
  if (query.length < MIN_SUGGESTION_QUERY_LENGTH) {
    return [];
  }
  const needle = query.toLowerCase();

  const [allCategories, categoryCounts, approvedProfiles] = await Promise.all([
    listCategories(db),
    countApprovedProvidersByCategory(db),
    listApprovedProviderProfilesForDiscover(db),
  ]);

  const categorySuggestions: DiscoverSuggestion[] = allCategories
    .filter((category) => category.name.toLowerCase().includes(needle))
    .map((category) => ({
      kind: "category",
      label: category.name,
      value: category.slug,
      count: categoryCounts.get(category.id) ?? 0,
    }));

  // Grouped by the exact string so "count" reflects how many approved
  // profiles that specific title/name actually covers, not a broader
  // substring match -- a suggestion is a single concrete pick, not another
  // free-text search.
  const titleCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const profile of approvedProfiles) {
    if (profile.title.toLowerCase().includes(needle)) {
      titleCounts.set(profile.title, (titleCounts.get(profile.title) ?? 0) + 1);
    }
    if (profile.displayName.toLowerCase().includes(needle)) {
      nameCounts.set(profile.displayName, (nameCounts.get(profile.displayName) ?? 0) + 1);
    }
  }
  const serviceSuggestions: DiscoverSuggestion[] = [...titleCounts.entries()].map(([title, count]) => ({
    kind: "service",
    label: title,
    value: title,
    count,
  }));
  const providerSuggestions: DiscoverSuggestion[] = [...nameCounts.entries()].map(([name, count]) => ({
    kind: "provider",
    label: name,
    value: name,
    count,
  }));

  return [...categorySuggestions, ...serviceSuggestions, ...providerSuggestions].slice(0, MAX_SUGGESTIONS);
}
