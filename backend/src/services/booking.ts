/**
 * Booking service functions later stories' routes call. Everything here is
 * thin: SQL lives in `../db/`, RPC lives in `../chain/`, and this module
 * only composes the two -- the layering the whole backend is written
 * against (routes -> services -> db/chain/anchor, one-way).
 *
 * What is deliberately *not* here: nothing in this file ever sets
 * `escrow_state`. That column belongs to `../chain/event-worker.ts` alone
 * (AD-1/AD-3); `lockDeposit` below only submits the chain call and returns
 * its transaction hash -- the booking's `escrowState` stays `null` until
 * the worker processes the `locked` event this call, if it succeeds,
 * eventually produces.
 */
import { randomBytes } from "node:crypto";

import * as chain from "../chain/client.js";
import { getBookingById, insertBooking, updateBalanceState, type BookingRow } from "../db/bookings.js";
import { getProviderProfileById } from "../db/providerProfiles.js";
import type { Db } from "../db/client.js";
import { BALANCE_STATES, type BalanceState } from "../db/schema.js";

/** 16 random bytes, hex-encoded -- the shape `db/schema.ts`'s
 * `bookings.id` and the contract's `BytesN<16>` both expect. AD-13 calls
 * this an "off-chain ULID"; a true ULID also encodes a sortable timestamp,
 * which nothing here currently relies on, so this story uses the simpler
 * shape that still satisfies every constraint the contract and the schema
 * actually enforce. */
export function generateBookingId(): string {
  return randomBytes(16).toString("hex");
}

export interface CreateBookingHoldInput {
  providerProfileId: string;
  clientWalletAddress: string;
  tokenAddress: string;
  /** Integer string, smallest unit (AD-7). */
  depositAmount: string;
  /** Integer string, smallest unit (AD-7); defaults to `"0"`. */
  balanceAmount?: string;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  /** Supply only for tests that need a deterministic id; a real caller
   * lets this generate one (AD-13: the backend, not the client, mints
   * `booking_id`). */
  bookingId?: string;
}

/**
 * Writes a booking's hold row (AD-13): before any chain call, so the
 * event worker has a row to mirror state onto once `locked` arrives.
 * Returns the booking id the caller (eventually, Epic 3's payment route)
 * passes to `lockDeposit`.
 */
export async function createBookingHold(db: Db, input: CreateBookingHoldInput): Promise<string> {
  const bookingId = input.bookingId ?? generateBookingId();
  await insertBooking(db, {
    id: bookingId,
    providerProfileId: input.providerProfileId,
    clientWalletAddress: input.clientWalletAddress,
    tokenAddress: input.tokenAddress,
    depositAmount: input.depositAmount,
    balanceAmount: input.balanceAmount,
    cancelDeadline: input.cancelDeadline,
    createdAt: Date.now(),
  });
  return bookingId;
}

export function getBooking(db: Db, bookingId: string): Promise<BookingRow | undefined> {
  return getBookingById(db, bookingId);
}

/** The backend's own half of AD-3: only ever touches `balance_state`,
 * validated against the three values that column may hold. */
export async function setBalanceState(db: Db, bookingId: string, balanceState: BalanceState): Promise<void> {
  if (!BALANCE_STATES.includes(balanceState)) {
    throw new TypeError(`balanceState must be one of ${BALANCE_STATES.join(", ")}, got "${balanceState}"`);
  }
  await updateBalanceState(db, bookingId, balanceState);
}

/**
 * Submits `create_booking` for an already-held booking. Resolves the
 * professional's wallet from the booking's own provider profile, so a
 * caller only ever needs the booking id and the client's signing keypair
 * -- never a raw chain argument list, which stays `chain/client.ts`'s
 * concern alone.
 *
 * Returns the submitted transaction's hash; the booking's `escrowState`
 * only becomes `"locked"` once the event worker processes the resulting
 * event, not as a side effect of this call succeeding.
 */
export async function lockDeposit(
  db: Db,
  bookingId: string,
  clientSigner: chain.Keypair,
  overrides?: Partial<chain.ChainCallDeps>,
): Promise<{ hash: string }> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new TypeError(`No booking hold exists for id "${bookingId}"`);
  }
  const providerProfile = await getProviderProfileById(db, booking.providerProfileId);
  if (!providerProfile) {
    throw new TypeError(`Booking "${bookingId}" references a provider profile that no longer exists`);
  }
  return chain.createBooking(
    {
      bookingId: booking.id,
      professional: providerProfile.walletAddress,
      client: booking.clientWalletAddress,
      token: booking.tokenAddress,
      amount: booking.depositAmount,
      cancelDeadline: booking.cancelDeadline,
    },
    clientSigner,
    overrides,
  );
}
