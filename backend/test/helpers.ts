/**
 * Shared fixtures for tests that need a real, migrated, temporary database
 * with a booking already on it. Not itself a test file (does not match
 * `test/*.test.ts`, so `npm run -w backend test` never runs it directly) --
 * every test file below imports from here instead of re-deriving the
 * category -> provider profile -> booking chain the schema's foreign keys
 * require.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { openDatabase, closeDatabase, type OpenDatabaseResult } from "../src/db/client.js";
import { categories, type BalanceState } from "../src/db/schema.js";
import { insertProviderProfile } from "../src/db/providerProfiles.js";
import { insertBooking } from "../src/db/bookings.js";
import type { ChainEvent, EventName } from "../src/chain/events.js";

/** A real, migrated, throwaway SQLite database -- `openDatabase(":memory:")`
 * per the story's own test convention. */
export function openTestDatabase(): OpenDatabaseResult {
  return openDatabase(":memory:");
}

export { closeDatabase };

export async function seedCategory(result: OpenDatabaseResult, id: string = randomUUID()): Promise<string> {
  await result.db.insert(categories).values({
    id,
    name: "Consulting",
    slug: `consulting-${id}`,
  });
  return id;
}

export interface SeedProviderProfileOptions {
  id?: string;
  categoryId?: string;
  walletAddress?: string;
  /** Defaults to `false`, matching the real default -- a profile this
   * story creates is unapproved until Story 4.1/4.2 decides otherwise
   * (PRD Story 4.1 AC4: an unapproved profile must never appear in a
   * marketplace listing). */
  isApproved?: boolean;
}

export async function seedProviderProfile(
  result: OpenDatabaseResult,
  options: SeedProviderProfileOptions = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  const categoryId = options.categoryId ?? (await seedCategory(result));
  await insertProviderProfile(result.db, {
    id,
    walletAddress: options.walletAddress ?? `GPROVIDER${id.replace(/-/g, "").toUpperCase().slice(0, 20)}`,
    categoryId,
    sessionFormat: "video",
    sessionLengthMinutes: 50,
    priceAmount: "10000000",
    depositRateBps: 2000,
    cancellationWindowHours: 24,
    isApproved: options.isApproved ?? false,
    createdAt: Date.now(),
  });
  return id;
}

export interface SeedBookingOptions {
  bookingId?: string;
  providerProfileId?: string;
  /** Defaults to a fake, non-checksummed placeholder -- fine for db-layer
   * tests, which store this as plain text. A test that goes through
   * `chain/client.ts` (e.g. `lockDeposit`) needs a real Stellar strkey
   * here instead, since `Address(...)` validates it. */
  clientWalletAddress?: string;
  /** Same caveat as `clientWalletAddress`: a fake placeholder by default,
   * override with a real contract strkey for a test that reaches the
   * chain client. */
  tokenAddress?: string;
  depositAmount?: string;
  balanceAmount?: string;
  balanceState?: BalanceState;
  cancelDeadline?: number;
}

/** 32 lowercase hex characters -- the same shape `chain/client.ts`'s
 * `BOOKING_ID_PATTERN` expects and `db/schema.ts`'s `bookings.id` stores. */
export function randomBookingId(): string {
  return randomBytes(16).toString("hex");
}

/** Seeds a category, a provider profile under it, and a booking hold row
 * referencing both -- the minimum the schema's foreign keys require before
 * the event worker can mirror any state onto a booking. Returns the
 * booking id. */
export async function seedBooking(result: OpenDatabaseResult, options: SeedBookingOptions = {}): Promise<string> {
  const bookingId = options.bookingId ?? randomBookingId();
  const providerProfileId = options.providerProfileId ?? (await seedProviderProfile(result));
  await insertBooking(result.db, {
    id: bookingId,
    providerProfileId,
    clientWalletAddress: options.clientWalletAddress ?? `GCLIENT${bookingId.toUpperCase().slice(0, 20)}`,
    tokenAddress: options.tokenAddress ?? `CTOKEN${bookingId.toUpperCase().slice(0, 20)}`,
    depositAmount: options.depositAmount ?? "1000000",
    balanceAmount: options.balanceAmount,
    cancelDeadline: options.cancelDeadline ?? Math.floor(Date.now() / 1000) + 3600,
    balanceState: options.balanceState,
    createdAt: Date.now(),
  });
  return bookingId;
}

export function fakeChainEvent(event: {
  bookingId: string;
  eventType: EventName;
  id?: string;
  ledger?: number;
  amount?: string;
}): ChainEvent {
  return {
    id: event.id ?? randomUUID(),
    ledger: event.ledger ?? 1,
    bookingId: event.bookingId,
    eventType: event.eventType,
    amount: event.amount ?? "1000000",
  };
}
