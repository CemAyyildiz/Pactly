/**
 * Booking service functions later stories' routes call. Everything here is
 * thin: SQL lives in `../db/`, the escrow boundary lives in `../escrow/`,
 * and this module only composes the two -- the layering the whole backend
 * is written against (routes -> services -> db/escrow/anchor, one-way).
 *
 * What is deliberately *not* here: nothing in this file ever sets
 * `escrow_state`. That column belongs to `../escrow/trustless-work/
 * reconciler.ts` alone (AD-1/AD-3, Story 2.6's retarget of
 * `../chain/event-worker.ts`); `lockDeposit` and `fundDeposit` below only
 * ever build unsigned XDR -- the booking's `escrowState` stays `null`
 * until the reconciler processes chain-confirmed evidence that the
 * resulting signed-and-submitted transactions actually landed.
 *
 * `lockDeposit`/`fundDeposit`/`resolveBookingDispute` no longer call
 * `../chain/client.ts` (Story 2.6): that module is superseded, not deleted
 * -- it stays in the tree, reviewed and tested, as a record of the
 * pre-pivot design (AD-8's own "no completed history is erased").
 *
 * **Why deploy and fund are two separate exported functions.** Building a
 * fund transaction against a contract that is not yet on chain is
 * unverified, and both transactions would otherwise share the client's
 * sequence number. `lockDeposit` builds and persists the deploy; a caller
 * signs and submits it, then calls `fundDeposit` once it has landed.
 * `lockDeposit` refuses to run a second time once any `contractId` is
 * persisted -- overwriting it could orphan a deploy (or fund) that already
 * landed; recovering an abandoned, never-signed deploy is deferred to
 * Epic 3.
 */
import { randomBytes } from "node:crypto";

import { defaultEscrowAdapter } from "../escrow/trustless-work/client.js";
import { getEscrowLifecycle } from "../escrow/trustless-work/reconciler.js";
import type { DeployEscrowResult, EscrowAdapter, UnsignedTransaction } from "../escrow/interface.js";
import {
  getBookingById,
  insertBooking,
  updateBalanceState,
  updateEscrowContractId,
  type BookingRow,
} from "../db/bookings.js";
import { recordEscrowDisputeResolution } from "../db/escrowDisputeResolutions.js";
import { getProviderProfileById } from "../db/providerProfiles.js";
import type { Db } from "../db/client.js";
import { BALANCE_STATES, type BalanceState, type DisputeOutcome } from "../db/schema.js";

/** Pactly's only supported asset for now (PRD): the deposit's trustline
 * symbol every `lockDeposit` deploy names. Not yet a per-booking or
 * per-provider choice -- when Pactly supports more than one asset, this
 * becomes an input instead of a constant. */
const DEPOSIT_ASSET_SYMBOL = "USDC";

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

export interface LockDepositResult {
  /** The escrow's predicted `contractId` -- the same value just persisted
   * on `bookings.escrowContractId`; `fundDeposit` reads it back off the
   * booking row rather than trusting a caller-supplied copy. */
  contractId: string;
  /** Unsigned deploy XDR, for the client's own signature. */
  deploy: DeployEscrowResult;
}

/** Refuses a `lockDeposit`/`fundDeposit`/`resolveBookingDispute` call whose
 * booking is not in the state that call requires -- e.g. `escrowState`
 * already set, or no `contractId` persisted yet. Named per the I/O
 * matrix's typed-refusal rows; this is a service-level state check, never
 * a Trustless Work condition, so it stays its own class rather than one of
 * `escrow/trustless-work/errors.ts`'s adapter-boundary errors. */
export class BookingEscrowStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingEscrowStateError";
  }
}

async function requireBooking(db: Db, bookingId: string): Promise<BookingRow> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new TypeError(`No booking hold exists for id "${bookingId}"`);
  }
  return booking;
}

async function requireProviderAddress(db: Db, booking: BookingRow): Promise<string> {
  const providerProfile = await getProviderProfileById(db, booking.providerProfileId);
  if (!providerProfile) {
    throw new TypeError(`Booking "${booking.id}" references a provider profile that no longer exists`);
  }
  return providerProfile.walletAddress;
}

/**
 * Builds the unsigned deploy XDR for an already-held booking and persists
 * the escrow's predicted `contractId` -- once, ever, per booking. Replaces
 * the old direct `chain.createBooking` call with the vendor-neutral
 * `EscrowAdapter`, and no longer also builds `fund` in the same call (see
 * this module's own top doc comment). The client address always comes from
 * the booking's own `clientWalletAddress` (AD-13's hold already recorded
 * it; a caller can no longer pass a different one, which closed a real
 * money-safety gap an earlier review found). Resolves the professional's
 * wallet from the booking's own provider profile, so a caller only ever
 * needs the booking id -- never a Trustless Work payload, which stays
 * `escrow/trustless-work/client.ts`'s concern alone.
 *
 * Refused (typed {@link BookingEscrowStateError}) once a `contractId` is
 * already persisted for this booking, regardless of `escrowState` --
 * overwriting it could orphan a deploy (and possibly a `fundDeposit`) that
 * already landed on chain, since nothing else ever looks anywhere but the
 * current column value. Recovering an abandoned deploy (one whose XDR was
 * never signed) is deferred to Epic 3, not handled by re-running this.
 */
export async function lockDeposit(
  db: Db,
  bookingId: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<LockDepositResult> {
  const booking = await requireBooking(db, bookingId);
  if (booking.escrowContractId !== null) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has a persisted escrow contractId; lockDeposit refuses to overwrite it`);
  }
  const providerAddress = await requireProviderAddress(db, booking);

  const deployResult = await adapter.deploy({
    bookingId: booking.id,
    clientAddress: booking.clientWalletAddress,
    providerAddress,
    tokenAddress: booking.tokenAddress,
    assetSymbol: DEPOSIT_ASSET_SYMBOL,
    amount: booking.depositAmount,
    title: `Pactly booking ${booking.id}`,
    description: `Pactly session deposit for booking ${booking.id}`,
  });
  await updateEscrowContractId(db, bookingId, deployResult.contractId);

  return { contractId: deployResult.contractId, deploy: deployResult };
}

/**
 * Builds the unsigned fund XDR against the `contractId` `lockDeposit`
 * already persisted -- never a caller-supplied one, so `fundDeposit` can
 * never be pointed at an escrow this booking never deployed.
 *
 * Refused (typed {@link BookingEscrowStateError}) when no `contractId` is
 * persisted yet (call `lockDeposit` first), or `escrowState` is already
 * set (the reconciler has already confirmed this booking's own money
 * state; a fund call at that point could only be stale or a replay).
 */
export async function fundDeposit(
  db: Db,
  bookingId: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<UnsignedTransaction> {
  const booking = await requireBooking(db, bookingId);
  if (!booking.escrowContractId) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" has no persisted escrow contractId; call lockDeposit first`);
  }
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has escrow_state "${booking.escrowState}"; cannot fund again`);
  }

  return adapter.fund({
    contractId: booking.escrowContractId,
    clientAddress: booking.clientWalletAddress,
    amount: booking.depositAmount,
  });
}

export interface ResolveBookingDisputeResult extends UnsignedTransaction {
  outcome: DisputeOutcome;
}

/**
 * Builds Pactly's own unsigned resolve-dispute XDR and records the
 * decision (Design Notes: "Why the resolution decision is recorded with
 * its txHash"; "Why dispute resolution is always one full-amount
 * distribution" -- Pactly's cancellation rule never splits a deposit).
 * Never triggered by a deadline (Story 1.8 AC7) -- only ever called on
 * Pactly's own explicit decision, made elsewhere (booking-policy logic
 * outside this story's scope), about who cancelled and when.
 *
 * Refused (typed {@link BookingEscrowStateError}), before the adapter is
 * ever called, unless the booking is `locked` with a persisted
 * `contractId` *and* the reconciler's own latest recorded lifecycle action
 * for that same `contractId` is `"disputed"` ({@link getEscrowLifecycle}) --
 * a dispute can only be resolved once the chain itself shows one open
 * against the escrow this booking actually deployed, never merely because
 * the booking's own `escrowState` happens to read `"locked"` (which is
 * also true before any dispute exists at all). Recording the decision is
 * an upsert ({@link recordEscrowDisputeResolution}): calling this again
 * replaces the earlier decision rather than raising a raw SQLite error,
 * since an unsigned or expired XDR from a first attempt must not
 * permanently lock the booking to a decision nobody ever signed.
 */
export async function resolveBookingDispute(
  db: Db,
  bookingId: string,
  outcome: DisputeOutcome,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<ResolveBookingDisputeResult> {
  const booking = await requireBooking(db, bookingId);
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be "locked" with a persisted escrow contractId to resolve a dispute ` +
        `(escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId || lifecycle.action !== "disputed") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed "disputed" evidence for its current escrow contractId; ` +
        "resolveBookingDispute refuses to build a resolution without it",
    );
  }
  const providerAddress = await requireProviderAddress(db, booking);
  const targetAddress = outcome === "refund-client" ? booking.clientWalletAddress : providerAddress;

  const result = await adapter.resolveDispute({
    contractId: booking.escrowContractId,
    distributions: [{ address: targetAddress, amount: booking.depositAmount }],
  });

  await recordEscrowDisputeResolution(db, {
    bookingId,
    contractId: booking.escrowContractId,
    outcome,
    txHash: result.txHash,
    decidedAt: Date.now(),
  });

  return { ...result, outcome };
}
