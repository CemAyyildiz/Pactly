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
 * `lockDeposit` never overwrites a `contractId` that may already have
 * landed (and possibly been funded): once one is persisted, it either
 * returns the exact same stored deploy XDR (a retry within the hold -- see
 * Story 3.4's own Design Notes, "Why retry reuses the stored deploy XDR")
 * or, only once chain evidence confirms the old contract was never
 * actually deployed, clears it and builds a fresh one (the abandoned-deploy
 * recovery Story 2.6 deferred to Epic 3, now implemented here).
 *
 * Story 3.4 also adds the real AD-13 slot hold (`holdSlot`), the owner
 * check every booking route shares (`getBookingForClient`), `submit`
 * (relaying a client-signed XDR), the booking read view (`getBookingView`),
 * and the hold-expiry double-sale detector (`expireHolds`) -- see each
 * function's own doc comment below.
 */
import { randomBytes } from "node:crypto";
import { TransactionBuilder } from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { defaultEscrowAdapter } from "../escrow/trustless-work/client.js";
import { getEscrowLifecycle } from "../escrow/trustless-work/reconciler.js";
import type { EscrowAdapter, SubmitTransactionResult, UnsignedTransaction } from "../escrow/interface.js";
import {
  getBookingById,
  getActiveBookingForWalletAndSlot,
  countPendingHoldsForWallet,
  insertBooking,
  insertBookingHoldIfSlotFree,
  listPotentialDoubleSales,
  listConflictingSlotBookings,
  clearUnsubmittedEscrowContractId,
  recordDeploySubmission,
  setEscrowFundTxHash,
  updateBalanceState,
  updateEscrowContractId,
  type BookingRow,
} from "../db/bookings.js";
import { getSlotById, getSlotByProviderAndStart, listOpenSlotsInRange } from "../db/availabilitySlots.js";
import { recordEscrowDisputeResolution } from "../db/escrowDisputeResolutions.js";
import { getProviderProfileById } from "../db/providerProfiles.js";
import { computeDepositAmount, ProviderNotFoundError } from "./profile.js";
import { resolveUsdcAsset, type ResolveUsdcAssetOptions } from "../anchor/usdc.js";
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
  /** Story 3.4: the slot this hold occupies, and the hold's own expiry.
   * Optional so every pre-3.4 caller (existing tests, `seed/demo.ts`) still
   * compiles unchanged; a real client-facing hold always goes through
   * {@link holdSlot} below instead, which always sets both. */
  slotId?: string;
  holdExpiresAt?: number;
}

/**
 * Writes a booking's hold row (AD-13): before any chain call, so the
 * event worker has a row to mirror state onto once `locked` arrives.
 * Returns the booking id the caller (eventually, Epic 3's payment route)
 * passes to `lockDeposit`.
 *
 * This is the plain, unconditional insert -- it never checks whether a
 * slot is already held. `holdSlot` below is the real entry point a
 * `POST /bookings/hold` route uses; this function stays for tests and
 * seed data that just need a booking row to exist.
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
    slotId: input.slotId,
    holdExpiresAt: input.holdExpiresAt,
    createdAt: Date.now(),
  });
  return bookingId;
}

export function getBooking(db: Db, bookingId: string): Promise<BookingRow | undefined> {
  return getBookingById(db, bookingId);
}

// ---------------------------------------------------------------------------
// Story 3.4: the real AD-13 slot hold, the owner-only escrow steps, and the
// booking read route's own service functions.
// ---------------------------------------------------------------------------

/** Matches `services/profile.ts`'s own `ASSET` -- Pactly's only supported
 * asset for now. Kept as a separate constant (not imported) the same way
 * `DEPOSIT_ASSET_SYMBOL` above already is; both name the same value for
 * different reasons (a trustline symbol vs. a response's `asset` field). */
const ASSET = "USDC";

export interface Money {
  /** Integer string, smallest unit (AD-7) -- never a float. */
  amount: string;
  asset: string;
}

export interface BookingProviderSummary {
  id: string;
  displayName: string;
  title: string;
}

/** The AD-13 hold's own duration -- 10 minutes, per the spec's "Always"
 * rule ("blocks the slot for 10 minutes"). */
export const HOLD_DURATION_SECONDS = 10 * 60;

export class SlotUnavailableError extends Error {
  constructor(message = "That slot isn't available.") {
    super(message);
    this.name = "SlotUnavailableError";
  }
}

export class SlotTakenError extends Error {
  /** The provider's other open slots on the same calendar day (the
   * caller's own local day when `tzOffsetMinutes` was supplied, UTC
   * otherwise) as the one that was just lost -- the spec's own
   * `details.sameDaySlots`. */
  readonly sameDaySlots: number[];
  constructor(sameDaySlots: number[]) {
    super("That slot just went.");
    this.name = "SlotTakenError";
    this.sameDaySlots = sameDaySlots;
  }
}

/** Review follow-up: a per-wallet cap on *pending* holds (not yet locked)
 * across every provider, so one wallet cannot tie up an unbounded number of
 * slots at once. */
export class TooManyHoldsError extends Error {
  constructor(message = "You already have too many slots on hold. Complete or let one expire first.") {
    super(message);
    this.name = "TooManyHoldsError";
  }
}

/** A booking id that does not exist, or exists but is not owned by the
 * caller's own wallet -- both collapse to the same shape (spec's own
 * "Always" rule: "Anyone else gets 404 BOOKING_NOT_FOUND, so bookings are
 * not enumerable"). Never distinguishes the two cases in its message. */
export class BookingNotFoundError extends Error {
  constructor(message = "No booking was found with that id.") {
    super(message);
    this.name = "BookingNotFoundError";
  }
}

/** The AD-13 hold's 10-minute window has passed while `escrowState` is
 * still `null` -- `lock` and `fund` both refuse with this; `submit` never
 * checks it (a transaction the client already signed must still be allowed
 * to land, per the spec's own "Never" rule on this point). */
export class BookingHoldExpiredError extends Error {
  constructor(message = "This hold has expired. The slot may already be taken again.") {
    super(message);
    this.name = "BookingHoldExpiredError";
  }
}

export interface HoldSlotInput {
  providerProfileId: string;
  clientWalletAddress: string;
  /** UTC epoch seconds -- must match one of the provider's own published
   * slots exactly. */
  slotStartsAt: number;
  /** The caller's own `Date.prototype.getTimezoneOffset()` value (minutes
   * to add to local time to reach UTC) -- used only to compute
   * `sameDaySlots`'s calendar-day window in the caller's own local day
   * rather than UTC. Omitted (or `0`) means UTC, the previous behavior. */
  tzOffsetMinutes?: number;
}

export interface HoldSlotResult {
  bookingId: string;
  holdExpiresAt: number;
  deposit: Money;
  balance: Money;
  price: Money;
  cancelDeadline: number;
  provider: BookingProviderSummary;
  /** `true` only when `cancelDeadline` has already passed at hold time --
   * the deposit is still locked as normal, but there is no free
   * cancellation window left to speak of. Omitted (never `false`) when it
   * has not. */
  freeCancellationEnded?: boolean;
}

export interface HoldSlotDeps {
  /** Injectable clock (UTC epoch seconds) -- defaults to the real one. */
  now?: number;
  /** Overrides how the USDC token address is resolved -- defaults to the
   * real, cached anchor lookup (`anchor/usdc.ts`). */
  resolveUsdcAsset?: (options?: ResolveUsdcAssetOptions) => Promise<{ contractId: string }>;
}

/** The calendar day `[start, end)` (UTC epoch seconds) containing
 * `startsAt`, in the day boundary implied by `tzOffsetMinutes` (the JS
 * `getTimezoneOffset()` convention: minutes to *add* to local time to reach
 * UTC) -- the window `SLOT_TAKEN`'s `sameDaySlots` searches. Defaults to
 * `0` (UTC) when the caller supplied none, the previous behavior. */
function dayRange(startsAt: number, tzOffsetMinutes = 0): { start: number; end: number } {
  const SECONDS_PER_DAY = 24 * 60 * 60;
  const offsetSeconds = tzOffsetMinutes * 60;
  const localStartsAt = startsAt - offsetSeconds;
  const localDayStart = Math.floor(localStartsAt / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const start = localDayStart + offsetSeconds;
  return { start, end: start + SECONDS_PER_DAY };
}

/**
 * The real AD-13 slot hold (`POST /bookings/hold`): validates the provider
 * and slot, derives every amount from the provider's own profile (the
 * spec's own "Always" rule -- "The frontend never supplies any amount"),
 * and atomically claims the slot via {@link insertBookingHoldIfSlotFree}.
 *
 * Refuses {@link SlotUnavailableError} (`404`/`409` per the route -- an
 * unknown/unapproved provider is `404 PROVIDER_NOT_FOUND`, everything else
 * about the slot itself is `409 SLOT_UNAVAILABLE`) for an unknown provider,
 * an unapproved provider, a slot that does not exist for this provider, or
 * a slot in the past. Refuses {@link SlotTakenError} (`409 SLOT_TAKEN`)
 * when another active booking already holds this exact slot -- the one
 * check this function's own single atomic insert statement decides, never
 * a separate read this function does first.
 */
const MAX_PENDING_HOLDS_PER_WALLET = 3;

export async function holdSlot(db: Db, input: HoldSlotInput, deps: HoldSlotDeps = {}): Promise<HoldSlotResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const resolveUsdc = deps.resolveUsdcAsset ?? resolveUsdcAsset;

  const profile = await getProviderProfileById(db, input.providerProfileId);
  if (!profile || !profile.isApproved) {
    throw new ProviderNotFoundError();
  }
  const slot = await getSlotByProviderAndStart(db, profile.id, input.slotStartsAt);
  if (!slot || slot.startsAt <= now) {
    throw new SlotUnavailableError();
  }

  const provider: BookingProviderSummary = { id: profile.id, displayName: profile.displayName, title: profile.title };

  // Review follow-up: the same wallet asking to hold a slot it already
  // actively holds gets that same booking back, not a spurious
  // `SLOT_TAKEN` -- a double-click, a retried request, or a reopened tab
  // are all the same wallet asking for what it already has.
  const existing = await getActiveBookingForWalletAndSlot(db, slot.id, input.clientWalletAddress, now);
  if (existing) {
    return {
      bookingId: existing.id,
      holdExpiresAt: existing.holdExpiresAt ?? now,
      deposit: { amount: existing.depositAmount, asset: ASSET },
      balance: { amount: existing.balanceAmount, asset: ASSET },
      price: { amount: (BigInt(existing.depositAmount) + BigInt(existing.balanceAmount)).toString(), asset: ASSET },
      cancelDeadline: existing.cancelDeadline,
      provider,
      ...(existing.cancelDeadline <= now ? { freeCancellationEnded: true as const } : {}),
    };
  }

  // Review follow-up: cap pending (unlocked) holds per wallet so one wallet
  // cannot tie up an unbounded number of slots at once.
  const pendingHolds = await countPendingHoldsForWallet(db, input.clientWalletAddress, now);
  if (pendingHolds >= MAX_PENDING_HOLDS_PER_WALLET) {
    throw new TooManyHoldsError();
  }

  const usdc = await resolveUsdc();
  const depositAmount = computeDepositAmount(profile.priceAmount, profile.depositRateBps);
  const balanceAmount = (BigInt(profile.priceAmount) - BigInt(depositAmount)).toString();
  const cancelDeadline = input.slotStartsAt - profile.cancellationWindowHours * 3600;
  const bookingId = generateBookingId();
  const holdExpiresAt = now + HOLD_DURATION_SECONDS;

  const inserted = await insertBookingHoldIfSlotFree(
    db,
    {
      id: bookingId,
      providerProfileId: profile.id,
      clientWalletAddress: input.clientWalletAddress,
      tokenAddress: usdc.contractId,
      depositAmount,
      balanceAmount,
      cancelDeadline,
      slotId: slot.id,
      holdExpiresAt,
      createdAt: Date.now(),
    },
    now,
  );

  if (!inserted) {
    const { start, end } = dayRange(input.slotStartsAt, input.tzOffsetMinutes);
    const sameDaySlots = await listOpenSlotsInRange(db, profile.id, start, end, now);
    throw new SlotTakenError(sameDaySlots.filter((startsAt) => startsAt !== input.slotStartsAt));
  }

  return {
    bookingId,
    holdExpiresAt,
    deposit: { amount: depositAmount, asset: ASSET },
    balance: { amount: balanceAmount, asset: ASSET },
    price: { amount: profile.priceAmount, asset: ASSET },
    cancelDeadline,
    provider,
    ...(cancelDeadline <= now ? { freeCancellationEnded: true as const } : {}),
  };
}

export { ProviderNotFoundError };

/** The backend's own half of AD-3: only ever touches `balance_state`,
 * validated against the three values that column may hold. */
export async function setBalanceState(db: Db, bookingId: string, balanceState: BalanceState): Promise<void> {
  if (!BALANCE_STATES.includes(balanceState)) {
    throw new TypeError(`balanceState must be one of ${BALANCE_STATES.join(", ")}, got "${balanceState}"`);
  }
  await updateBalanceState(db, bookingId, balanceState);
}

/**
 * `lockDeposit`'s own response shape (review follow-up, replacing the old
 * `{contractId, deploy}` shape): `deployed: true` means a signed deploy has
 * already been submitted and accepted for this booking -- there is no XDR
 * to sign again, and the caller should go straight to `fundDeposit`.
 * `deployed: false` carries the unsigned deploy XDR (and its own `txHash`,
 * always the real one Trustless Work returned -- never the `contractId`
 * used as a stand-in, which is what this shape replaces) still waiting for
 * a signature.
 */
export type LockDepositResult =
  | { deployed: true; contractId: string }
  | { deployed: false; contractId: string; unsignedXdr: string; txHash: string };

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

/** A signed transaction `submitSignedTransaction` was handed does not
 * match this booking's own stored deploy or fund `txHash` -- either a
 * stale/foreign envelope, or one that failed to decode at all. Refused
 * before the transaction is ever relayed to Trustless Work. */
export class XdrMismatchError extends Error {
  constructor(message = "This transaction doesn't match what Pactly built for this booking.") {
    super(message);
    this.name = "XdrMismatchError";
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

/** Refuses {@link BookingHoldExpiredError} once `holdExpiresAt` has passed
 * (`<= now`, matching the exact boundary every other expiry check in this
 * codebase uses -- `insertBookingHoldIfSlotFree`'s own "active" definition
 * is `> now`, so a row exactly at `now` is expired, never both) with
 * `escrowState` still `null`. A `null` `holdExpiresAt` (a booking inserted
 * before Story 3.4, or through the plain `createBookingHold` helper) never
 * expires -- there is nothing to compare against. Once `escrowState` is set
 * the hold is moot (the deposit already reconciled), so this never fires
 * for a booking past that point either. */
function requireHoldNotExpired(booking: BookingRow, now: number): void {
  if (booking.escrowState === null && booking.holdExpiresAt !== null && booking.holdExpiresAt <= now) {
    throw new BookingHoldExpiredError();
  }
}

export interface LockDepositDeps {
  /** Injectable clock (UTC epoch seconds) -- defaults to the real one. */
  now?: number;
  /** An explicit request to discard the currently-persisted (never
   * submitted) deploy and build a fresh one -- the caller's own decision,
   * made only after a submit attempt failed and the client wants a new
   * transaction rather than retrying the old one. Ignored (never rebuilds)
   * once a deploy has actually been submitted for this booking. */
  rebuild?: boolean;
}

/**
 * Builds the unsigned deploy XDR for an already-held booking and persists
 * the escrow's predicted `contractId` (and Trustless Work's own `txHash`
 * for it) -- once, ever, per booking, unless the caller explicitly asks to
 * rebuild one that was never submitted. Replaces the old direct
 * `chain.createBooking` call with the vendor-neutral `EscrowAdapter`, and
 * no longer also builds `fund` in the same call (see this module's own top
 * doc comment). The client address always comes from the booking's own
 * `clientWalletAddress` (AD-13's hold already recorded it). Resolves the
 * professional's wallet from the booking's own provider profile, so a
 * caller only ever needs the booking id.
 *
 * Refused (typed {@link BookingEscrowStateError}) once `escrowState` is
 * already set -- the reconciler has already confirmed this booking's money
 * state, so a lock call at that point could only be stale. Refused (typed
 * {@link BookingHoldExpiredError}) once the hold has expired with
 * `escrowState` still `null`.
 *
 * **Retry (Story 3.4, Design Notes: "Why retry reuses the stored deploy
 * XDR").** When a `contractId` is already persisted and a deploy has
 * already been submitted for it (`deploySubmittedAt` set), this returns
 * `{deployed: true, contractId}` -- there is nothing left to sign, the
 * caller should move straight to `fundDeposit`. Otherwise, absent
 * `rebuild: true`, this returns the exact same stored `{contractId,
 * unsignedXdr, txHash}` again, with no new adapter call -- a declined
 * wallet signature must be retryable within the hold. If no XDR is stored
 * at all (a pre-review-follow-up row) and `rebuild` was not requested, this
 * refuses (typed {@link BookingEscrowStateError}) rather than return an
 * incomplete result; the caller must pass `rebuild: true` to get a usable
 * XDR.
 *
 * **Rebuild.** `rebuild: true` clears the stored (never-submitted) deploy
 * and builds a fresh one, conditioned in SQL on no deploy submission being
 * recorded and `escrowState` still `null` ({@link clearUnsubmittedEscrowContractId})
 * -- this never risks abandoning money already in flight, and no longer
 * guesses via a `listEscrows` chain read (removed: the caller, who knows
 * whether their own submit attempt actually failed, is a better judge of
 * "abandoned" than an inferred chain read ever was).
 *
 * **Concurrency.** Two concurrent `lockDeposit` calls building a *first*
 * deploy race on the same conditioned `updateEscrowContractId` write; the
 * loser's write is caught (never left to escape as a raw, untyped error)
 * and this simply re-reads the row and re-runs from the top, which then
 * returns whatever the winner actually persisted (a `{deployed: true}`, a
 * retryable stored XDR, or a typed {@link BookingEscrowStateError} if the
 * booking has moved on further still).
 */
export async function lockDeposit(
  db: Db,
  bookingId: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  deps: LockDepositDeps = {},
): Promise<LockDepositResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const booking = await requireBooking(db, bookingId);
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has escrow_state "${booking.escrowState}"; lockDeposit cannot run again`);
  }
  requireHoldNotExpired(booking, now);

  if (booking.escrowContractId !== null) {
    if (booking.deploySubmittedAt !== null) {
      return { deployed: true, contractId: booking.escrowContractId };
    }
    if (deps.rebuild) {
      // Clears the stale contractId so the recursive call below builds a
      // fresh deploy. If this write lost a race (a submit landed, or the
      // reconciler moved the booking on, between the read above and here),
      // it is simply a no-op and the recursive call below re-reads the
      // row's actual current state instead of trusting this now-possibly-
      // stale snapshot.
      await clearUnsubmittedEscrowContractId(db, bookingId, booking.escrowContractId);
      return lockDeposit(db, bookingId, adapter, { ...deps, rebuild: false });
    }
    if (!booking.escrowDeployXdr || !booking.escrowDeployTxHash) {
      throw new BookingEscrowStateError(
        `Booking "${bookingId}" has a persisted escrow contractId with no stored deploy XDR to retry; pass rebuild: true to build a fresh one`,
      );
    }
    return { deployed: false, contractId: booking.escrowContractId, unsignedXdr: booking.escrowDeployXdr, txHash: booking.escrowDeployTxHash };
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
  try {
    await updateEscrowContractId(db, bookingId, deployResult.contractId, deployResult.unsignedXdr, deployResult.txHash);
  } catch (error) {
    if (error instanceof TypeError) {
      // Lost a race to a concurrent lockDeposit call that persisted first
      // -- never let that raw TypeError escape as an untyped 500. Re-read
      // and let the guards above decide from the row's actual state.
      return lockDeposit(db, bookingId, adapter, deps);
    }
    throw error;
  }

  return { deployed: false, contractId: deployResult.contractId, unsignedXdr: deployResult.unsignedXdr, txHash: deployResult.txHash };
}

export interface FundDepositDeps {
  now?: number;
}

/**
 * Builds the unsigned fund XDR against the `contractId` `lockDeposit`
 * already persisted -- never a caller-supplied one, so `fundDeposit` can
 * never be pointed at an escrow this booking never deployed. Stores
 * Trustless Work's own `txHash` for the built transaction so
 * `submitSignedTransaction` can match a signed envelope against it.
 *
 * Refused (typed {@link BookingEscrowStateError}) when no `contractId` is
 * persisted yet, or no deploy has actually been submitted for it yet
 * (review follow-up: building a fund transaction against a contract that
 * may not exist on chain is unverified -- `deploySubmittedAt` is the
 * booking's own recorded evidence that a deploy was relayed, not merely
 * built), or `escrowState` is already set (the reconciler has already
 * confirmed this booking's own money state; a fund call at that point
 * could only be stale or a replay). Refused (typed
 * {@link BookingHoldExpiredError}) once the hold has expired with
 * `escrowState` still `null`.
 */
export async function fundDeposit(
  db: Db,
  bookingId: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  deps: FundDepositDeps = {},
): Promise<UnsignedTransaction> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const booking = await requireBooking(db, bookingId);
  if (!booking.escrowContractId || !booking.deploySubmittedAt) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no confirmed deploy submission yet; call lockDeposit and submit it first`,
    );
  }
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has escrow_state "${booking.escrowState}"; cannot fund again`);
  }
  requireHoldNotExpired(booking, now);

  const result = await adapter.fund({
    contractId: booking.escrowContractId,
    clientAddress: booking.clientWalletAddress,
    amount: booking.depositAmount,
  });
  await setEscrowFundTxHash(db, bookingId, result.txHash);
  return result;
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

// ---------------------------------------------------------------------------
// Story 3.4: the owner check every booking route shares, `submit`, the
// booking read view, and the hold-expiry runner tick.
// ---------------------------------------------------------------------------

/**
 * The one place `lock`/`fund`/`submit`/`GET /bookings/:id` all resolve
 * "does this booking exist, and does the caller's own wallet own it" --
 * both a missing booking and an owner mismatch throw the identical
 * {@link BookingNotFoundError}, so a caller can never learn which one it
 * was (the spec's own "Always" rule: "bookings are not enumerable").
 */
export async function getBookingForClient(db: Db, bookingId: string, walletAddress: string): Promise<BookingRow> {
  const booking = await getBookingById(db, bookingId);
  if (!booking || booking.clientWalletAddress !== walletAddress) {
    throw new BookingNotFoundError();
  }
  return booking;
}

export interface BookingView {
  id: string;
  escrowState: BookingRow["escrowState"];
  /** The finer lifecycle label Epic 3's UI needs (Story 2.6's
   * `getEscrowLifecycle`) -- `undefined` fields when nothing has been
   * recorded yet. */
  lifecycle: { contractId?: string; action?: string; outcome?: DisputeOutcome };
  holdExpiresAt: number | null;
  contractId: string | null;
  deposit: Money;
  balance: Money;
  price: Money;
  slotStartsAt: number | null;
  cancelDeadline: number;
  provider: BookingProviderSummary;
}

/** `GET /bookings/:id`'s own response shape: the booking's amounts (each
 * derived the same way `holdSlot` derived them, from the persisted
 * `depositAmount`/`balanceAmount` -- never recomputed from the current
 * provider profile, which could have changed its rules since), its
 * chain-derived lifecycle, and a small provider summary. The UI is told
 * `locked` only from here (`escrowState`), never from a submit response
 * (spec's own "Always" rule). */
export async function getBookingView(db: Db, bookingId: string, walletAddress: string): Promise<BookingView> {
  const booking = await getBookingForClient(db, bookingId, walletAddress);
  const profile = await getProviderProfileById(db, booking.providerProfileId);
  const lifecycle = (await getEscrowLifecycle(db, bookingId)) ?? {};
  const slot = booking.slotId ? await getSlotById(db, booking.slotId) : undefined;
  const slotStartsAt = slot?.startsAt ?? null;
  return {
    id: booking.id,
    escrowState: booking.escrowState,
    lifecycle: { contractId: lifecycle.contractId, action: lifecycle.action, outcome: lifecycle.outcome },
    holdExpiresAt: booking.holdExpiresAt,
    contractId: booking.escrowContractId,
    deposit: { amount: booking.depositAmount, asset: ASSET },
    balance: { amount: booking.balanceAmount, asset: ASSET },
    price: { amount: (BigInt(booking.depositAmount) + BigInt(booking.balanceAmount)).toString(), asset: ASSET },
    slotStartsAt,
    cancelDeadline: booking.cancelDeadline,
    provider: profile
      ? { id: profile.id, displayName: profile.displayName, title: profile.title }
      : { id: booking.providerProfileId, displayName: "", title: "" },
  };
}

/** Decodes a signed transaction envelope and returns its hash as lowercase
 * hex -- signing a transaction never changes the hash used to verify it
 * (the hash covers the signature payload, not the signatures themselves),
 * so this is exactly comparable to the `txHash` Trustless Work returned
 * when it built the corresponding *unsigned* XDR. Throws
 * {@link XdrMismatchError} for anything that does not decode as a
 * transaction at all, rather than let a raw stellar-sdk parse error escape. */
function computeSignedTransactionHash(signedXdr: string): string {
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, config.stellarNetworkPassphrase);
    // `Transaction.hash()` returns a `Uint8Array`, not a Node `Buffer` --
    // wrap it to get `.toString("hex")`.
    return Buffer.from(tx.hash()).toString("hex").toLowerCase();
  } catch {
    throw new XdrMismatchError();
  }
}

/**
 * Relays a client-signed transaction to Trustless Work, over the adapter's
 * own `submit` -- but only once this booking's own records confirm the
 * signed envelope actually is one Pactly built for it. Review follow-up:
 * `submitSignedTransaction` previously relayed *any* signed XDR handed to
 * it, unchecked -- a stranger's (or a stale, or a wrong-booking) signed
 * transaction could be relayed through someone else's booking. This
 * decodes the envelope, computes its own hash, and requires that hash to
 * equal the booking's own stored `escrowDeployTxHash` or
 * `escrowFundTxHash`; anything else is refused (typed
 * {@link XdrMismatchError}) before the adapter is ever called.
 *
 * Never checks the hold's expiry (the spec's own "Never" rule: "Submit is
 * allowed after expiry, because a transaction the client already signed
 * must still land and be reconciled") -- and never itself writes
 * `escrow_state` (AD-1); the reconciler is still the only writer, once it
 * reads this transaction's evidence back out of Trustless Work's own read
 * model.
 *
 * On a deploy match, once the adapter accepts it, this records
 * `deploySubmittedAt` and extends the hold to ten minutes from now (a
 * write-once, best-effort record -- see {@link recordDeploySubmission}'s
 * own doc comment for why a race or a resubmit never turns into an error
 * here).
 */
export async function submitSignedTransaction(
  db: Db,
  bookingId: string,
  signedXdr: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SubmitTransactionResult> {
  const booking = await requireBooking(db, bookingId);
  const hash = computeSignedTransactionHash(signedXdr);

  const matchesDeploy = booking.escrowDeployTxHash !== null && booking.escrowDeployTxHash.toLowerCase() === hash;
  const matchesFund = !matchesDeploy && booking.escrowFundTxHash !== null && booking.escrowFundTxHash.toLowerCase() === hash;
  if (!matchesDeploy && !matchesFund) {
    throw new XdrMismatchError();
  }

  const result = await adapter.submit(signedXdr);

  if (matchesDeploy && booking.escrowContractId) {
    await recordDeploySubmission(db, bookingId, booking.escrowContractId, booking.escrowDeployTxHash!, now + HOLD_DURATION_SECONDS, now);
  }

  return result;
}

/**
 * Story 3.4's hold-expiry runner tick: a read-only sweep that logs two
 * kinds of double-sale risk (never writes anything; the actual freeing of
 * a slot happens implicitly, at the next `holdSlot` call's own atomic
 * insert):
 *
 * 1. The spec's own Design Notes case: an expired hold whose deploy is
 *    still in flight (`escrowContractId` set, `escrowState` still `null`)
 *    on a slot some other active booking has since re-held.
 * 2. Review follow-up, a safety net: two distinct bookings sharing one
 *    slot where at least one already has a non-null, non-refunded
 *    `escrow_state` and the other is also locked/released/refunded or
 *    still an actively-held pending hold -- something
 *    {@link insertBookingHoldIfSlotFree}'s own atomic guarantee should
 *    make impossible, logged if it is ever seen anyway. Each unordered
 *    `(slotId, bookingA, bookingB)` pair is logged at most once per process
 *    (an in-memory set -- restarting the process re-arms it, which is fine
 *    for a log line, not a correctness mechanism).
 */
const loggedConflictPairs = new Set<string>();

export function expireHolds(db: Db, now: number = Math.floor(Date.now() / 1000), log: (message: string) => void = console.error): number {
  const potentialDoubleSales = listPotentialDoubleSales(db, now);
  for (const risk of potentialDoubleSales) {
    log(
      `[hold-expiry] anomaly: booking ${risk.bookingId}'s hold expired with escrow ${risk.contractId} still unconfirmed, ` +
        `and slot ${risk.slotId} has since been re-held by another booking -- watch for a double-sale if ${risk.contractId} funds`,
    );
  }

  let newlyLoggedConflicts = 0;
  for (const pair of listConflictingSlotBookings(db, now)) {
    const key = [pair.slotId, ...[pair.bookingIdA, pair.bookingIdB].sort()].join("|");
    if (loggedConflictPairs.has(key)) continue;
    loggedConflictPairs.add(key);
    newlyLoggedConflicts += 1;
    log(
      `[hold-expiry] anomaly: slot ${pair.slotId} has conflicting bookings ${pair.bookingIdA} and ${pair.bookingIdB}, ` +
        "both locked/released or actively held -- this should be impossible; investigate a possible double-sale",
    );
  }

  return potentialDoubleSales.length + newlyLoggedConflicts;
}
