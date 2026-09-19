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
import {
  getEscrowLifecycle,
  getEscrowLifecycleForBookings,
  type EscrowLifecycle,
  type EscrowLifecycleAction,
} from "../escrow/trustless-work/reconciler.js";
import type { EscrowAdapter, SubmitTransactionResult, UnsignedTransaction } from "../escrow/interface.js";
import {
  getBookingById,
  getBookingsByIds,
  getActiveBookingForWalletAndSlot,
  getReconcilableBookings,
  countPendingHoldsForWallet,
  insertBooking,
  insertBookingHoldIfSlotFree,
  listBookingRowsForClient,
  listBookingRowsForProvider,
  listPotentialDoubleSales,
  listConflictingSlotBookings,
  clearUnsubmittedEscrowContractId,
  recordDeploySubmission,
  setEscrowActionSubmittedAt,
  setEscrowActionTxHash,
  setEscrowFundTxHash,
  setPendingDispute,
  updateBalanceState,
  updateEscrowContractId,
  type BookingRow,
  type EscrowActionKind,
} from "../db/bookings.js";
import { getSlotById, getSlotByProviderAndStart, listOpenSlotsInRange } from "../db/availabilitySlots.js";
import { recordEscrowDisputeResolution } from "../db/escrowDisputeResolutions.js";
import { getEscrowDisputeOpeningsForBookings, recordEscrowDisputeOpening } from "../db/escrowDisputeOpenings.js";
import { getProviderProfileById, getProviderProfileByWallet } from "../db/providerProfiles.js";
import { computeDepositAmount, NotAProviderError, ProviderNotFoundError } from "./profile.js";
import { resolveUsdcAsset, type ResolveUsdcAssetOptions } from "../anchor/usdc.js";
import type { Db } from "../db/client.js";
import { BALANCE_STATES, type BalanceState, type DisputeOpenerRole, type DisputeOutcome, type DisputeReason } from "../db/schema.js";

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

/** Story 3.6 (review round): a fresh build of an action was requested while
 * an earlier signed transaction for that *same* action kind on this booking
 * has already been relayed and the reconciler's own chain-derived lifecycle
 * has not yet moved past what that action would produce -- refused rather
 * than silently building a second, competing transaction for a signature
 * that may already be in flight (`db/bookings.ts`'s per-kind
 * `escrow*SubmittedAt` columns are what this checks). */
export class BookingActionPendingError extends Error {
  constructor(message = "This action is already awaiting on-chain confirmation.") {
    super(message);
    this.name = "BookingActionPendingError";
  }
}

/** Story 3.6 (review round): a dispute `reason` that either does not exist
 * at all, or is not one the caller's own role may claim (e.g. a client
 * claiming `client-no-show`, which only the provider may claim). */
export class InvalidDisputeReasonError extends Error {
  constructor(message = "That reason isn't valid for your role on this booking.") {
    super(message);
    this.name = "InvalidDisputeReasonError";
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
  if (booking.escrowResolveSubmittedAt !== null) {
    // A resolve for this same dispute is already awaiting chain
    // confirmation (the lifecycle above is still "disputed", not yet
    // "resolved") -- refuse a second, competing resolve XDR rather than
    // building one nobody asked to replace the first with.
    throw new BookingActionPendingError();
  }
  const providerAddress = await requireProviderAddress(db, booking);
  const targetAddress = outcome === "refund-client" ? booking.clientWalletAddress : providerAddress;

  const result = await adapter.resolveDispute({
    contractId: booking.escrowContractId,
    distributions: [{ address: targetAddress, amount: booking.depositAmount }],
  });

  const decidedAt = Math.floor(Date.now() / 1000);
  await recordEscrowDisputeResolution(db, {
    bookingId,
    contractId: booking.escrowContractId,
    outcome,
    txHash: result.txHash,
    decidedAt,
  });
  // Also stored on the booking row itself (duplicated from the row above)
  // so `submitSignedTransaction`'s hash-matching rule can check every
  // Story 3.6 action's hash from one row, without a second query.
  await setEscrowActionTxHash(db, bookingId, "resolve", result.txHash);

  return { ...result, outcome };
}

// ---------------------------------------------------------------------------
// Story 3.6: appointment completion, release and resolution. Every action
// below follows the same shape: resolve ownership (404 if the caller does
// not hold the required role on this booking), guard the current lifecycle
// state (409 BOOKING_STATE otherwise), call the adapter, then store the
// built transaction's own txHash on the booking so `submitSignedTransaction`
// can relay only a signed envelope Pactly actually built for this booking
// and this role (the spec's own "Always" rule).
// ---------------------------------------------------------------------------

/**
 * "Complete" (provider only): the provider's own signed declaration that the
 * appointment happened -- `EscrowAdapter.complete`, milestone 0 status
 * `"completed"`. Refused (typed {@link BookingEscrowStateError}) unless the
 * booking is `locked` with a persisted `contractId` and the reconciler's own
 * latest recorded lifecycle action is `"funded"` (or nothing has been
 * recorded past that yet is impossible once `escrowState` reads `"locked"`,
 * since that column is only ever set alongside a recorded action) -- calling
 * this again once the appointment is already `completed`/`approved`/
 * `disputed`/`released` is refused the same way. Never moves money itself;
 * `escrow_state` stays `locked` either way (AD-1).
 */
export async function completeAppointment(
  db: Db,
  bookingId: string,
  providerWalletAddress: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<UnsignedTransaction> {
  const booking = await getBookingForProvider(db, bookingId, providerWalletAddress);
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to complete it (escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed evidence yet for its current escrow contractId`,
    );
  }
  if (booking.escrowCompleteSubmittedAt !== null && lifecycle.action === "funded") {
    throw new BookingActionPendingError();
  }
  if (lifecycle.action !== "funded") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" cannot be completed from its current lifecycle state ("${lifecycle.action}")`,
    );
  }
  const result = await adapter.complete({ contractId: booking.escrowContractId, providerAddress: providerWalletAddress });
  await setEscrowActionTxHash(db, bookingId, "complete", result.txHash);
  return result;
}

/**
 * "Approve" (client only): the approver's own signature -- allowed once the
 * appointment is either merely `funded` or already `completed` (the spec's
 * own I/O-matrix row: "Approve | Client, lifecycle completed or funded"),
 * refused (typed {@link BookingEscrowStateError}) from any other state
 * (`disputed`, `approved` again, `released`, `resolved`, or not locked at
 * all).
 */
export async function approveAppointment(
  db: Db,
  bookingId: string,
  clientWalletAddress: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<UnsignedTransaction> {
  const booking = await getBookingForClient(db, bookingId, clientWalletAddress);
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to approve it (escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed evidence yet for its current escrow contractId`,
    );
  }
  if (booking.escrowApproveSubmittedAt !== null && (lifecycle.action === "funded" || lifecycle.action === "completed")) {
    throw new BookingActionPendingError();
  }
  if (lifecycle.action !== "funded" && lifecycle.action !== "completed") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" cannot be approved from its current lifecycle state ("${lifecycle.action}")`,
    );
  }
  const result = await adapter.approve({ contractId: booking.escrowContractId, clientAddress: clientWalletAddress });
  await setEscrowActionTxHash(db, bookingId, "approve", result.txHash);
  return result;
}

/**
 * "Release" (provider only, self-claim): refused (typed
 * {@link BookingEscrowStateError}) unless the reconciler's own latest
 * recorded lifecycle action is exactly `"approved"` -- per the spec's own
 * role map row ("release: provider wallet (release signer), only when the
 * latest lifecycle is approved and not disputed"). A dispute opened after
 * approval would itself become the *latest* recorded action (the
 * reconciler's own rank puts `disputed` above `approved`), so checking for
 * `"approved"` alone already excludes that case -- no separate "not
 * disputed" check is needed.
 */
export async function releaseDeposit(
  db: Db,
  bookingId: string,
  providerWalletAddress: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<UnsignedTransaction> {
  const booking = await getBookingForProvider(db, bookingId, providerWalletAddress);
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to release it (escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed evidence yet for its current escrow contractId`,
    );
  }
  if (booking.escrowReleaseSubmittedAt !== null && lifecycle.action === "approved") {
    throw new BookingActionPendingError();
  }
  if (lifecycle.action !== "approved") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" cannot be released from its current lifecycle state ("${lifecycle.action}"); it must be "approved"`,
    );
  }
  const result = await adapter.release({ contractId: booking.escrowContractId, providerAddress: providerWalletAddress });
  await setEscrowActionTxHash(db, bookingId, "release", result.txHash);
  return result;
}

/**
 * Story 3.6 (review round): each dispute reason is bound to whichever role
 * may actually claim it -- a client may claim that the client is cancelling,
 * that the provider did not show up, or a plain disagreement; a provider's
 * own three mirror that. `openDispute` refuses (typed
 * {@link InvalidDisputeReasonError}) any reason outside the caller's own
 * role's set, including the other role's reasons and any unrecognized
 * string.
 */
const CLIENT_DISPUTE_REASONS: readonly DisputeReason[] = ["client-cancel", "provider-no-show", "disagreement"];
const PROVIDER_DISPUTE_REASONS: readonly DisputeReason[] = ["provider-cancel", "client-no-show", "disagreement"];

function isDisputeReasonAllowedForRole(reason: DisputeReason, role: "client" | "provider"): boolean {
  const allowed = role === "client" ? CLIENT_DISPUTE_REASONS : PROVIDER_DISPUTE_REASONS;
  return (allowed as readonly string[]).includes(reason);
}

/**
 * The cancellation and no-show policy (decided 2026-09-18, "who cancels
 * decides", stated in EXPERIENCE.md before any dispute ever opens): the
 * provider cancelling, or the provider not showing up, both point at a full
 * refund to the client; the client not showing up points at the full
 * deposit going to the provider; the client cancelling points at a full
 * refund at or before `cancelDeadline`, and the full deposit to the provider
 * after it. `"disagreement"` has no policy-implied outcome at all --
 * `undefined`, never a guessed value -- so the admin picks with no steer
 * (Story 3.6's own Boundaries: "The suggestion is guidance, never automatic"
 * applies doubly here, since there is no suggestion).
 */
function computeSuggestedOutcome(reason: DisputeReason, booking: BookingRow, now: number): DisputeOutcome | undefined {
  switch (reason) {
    case "provider-cancel":
    case "provider-no-show":
      return "refund-client";
    case "client-no-show":
      return "pay-provider";
    case "client-cancel":
      return now <= booking.cancelDeadline ? "refund-client" : "pay-provider";
    case "disagreement":
      return undefined;
  }
}

export interface OpenDisputeResult extends UnsignedTransaction {
  reason: DisputeReason;
  suggestedOutcome?: DisputeOutcome;
}

/**
 * "Dispute" (client or provider): either side may raise one while the
 * booking is `locked` and no dispute is already open for it -- refused
 * (typed {@link BookingEscrowStateError}) once `escrowState` is not
 * `locked` at all (never locked yet, or already `released`/`refunded`,
 * covering the spec's own "Released or resolved: 409" row), the reconciler's
 * own chain-derived lifecycle has not yet caught up to the booking's current
 * `contractId`, or the reconciler's own latest recorded action is already
 * `"disputed"`. Refused (typed {@link InvalidDisputeReasonError}) for a
 * `reason` outside the caller's own role's whitelist. Refused (typed
 * {@link BookingActionPendingError}) while an earlier dispute build for this
 * booking has already been submitted and the lifecycle has not yet observed
 * it. Pactly itself never opens a dispute (Story 1.8 AC7): `signerAddress`
 * is always the caller's own wallet, one of the two parties, never Pactly's.
 *
 * Review round: building the XDR no longer writes `escrow_dispute_openings`
 * -- it only stores the pending hash/reason/opener on the booking row
 * ({@link setPendingDispute}, "last builder wins": a "Never mind" that never
 * signs leaves no opening record at all). The real record, with its
 * `suggestedOutcome` computed against the *submit*-time clock, is written by
 * `submitSignedTransaction` once a signed transaction matching this hash is
 * actually relayed.
 */
export async function openDispute(
  db: Db,
  bookingId: string,
  walletAddress: string,
  reason: DisputeReason,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  now: number = Math.floor(Date.now() / 1000),
): Promise<OpenDisputeResult> {
  const { booking, role } = await getBookingForClientOrProvider(db, bookingId, walletAddress);
  if (!isDisputeReasonAllowedForRole(reason, role)) {
    throw new InvalidDisputeReasonError();
  }
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to open a dispute (escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed evidence yet for its current escrow contractId`,
    );
  }
  if (booking.escrowDisputeSubmittedAt !== null && lifecycle.action !== "disputed") {
    throw new BookingActionPendingError();
  }
  if (lifecycle.action === "disputed") {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has an open dispute`);
  }
  const result = await adapter.startDispute({ contractId: booking.escrowContractId, signerAddress: walletAddress, reason });
  const suggestedOutcome = computeSuggestedOutcome(reason, booking, now);
  await setPendingDispute(db, bookingId, { txHash: result.txHash, reason, openerWallet: walletAddress, openerRole: role });
  return { ...result, reason, suggestedOutcome };
}

export interface AdminDisputeListItem {
  bookingId: string;
  contractId: string;
  /** `""` when no opening record exists for this booking's current
   * contract (a dispute raised outside Pactly's own route, in principle) --
   * see this function's own doc comment. */
  openedByWallet: string;
  openedByRole?: DisputeOpenerRole;
  reason: DisputeReason | "unknown";
  suggestedOutcome?: DisputeOutcome;
  amount: Money;
  provider: BookingProviderSummary;
  clientWalletAddress: string;
  slotStartsAt: number | null;
  /** Story 3.6 (review round): `"resolve"` while an admin's resolve is
   * already awaiting chain confirmation for this booking -- the admin UI
   * hides/disables the row rather than let a second resolve be built. */
  pendingAction: EscrowActionKind | null;
}

/**
 * `GET /admin/disputes`: every booking whose reconciler-derived lifecycle
 * currently reads `"disputed"` for its own `contractId` (review round: driven
 * from the bookings themselves, not from `escrow_dispute_openings`, since an
 * opening is now only ever recorded once a dispute build is actually
 * submitted -- a booking can be genuinely disputed on chain with no opening
 * record at all if the dispute was raised outside Pactly's own route),
 * left-joined to its own opening record (`reason: "unknown"` when none
 * matches the booking's current contract), plus the opener's role, the
 * policy's own suggested outcome (guidance only -- "The admin may pick
 * either outcome" per the spec's own "Always" rule), and the deposit amount.
 * Provider/slot lookups are batched (deduped ids, `Promise.all`), never one
 * query per row. Route-level authorization (an admin wallet) is the
 * caller's job; this function itself has no notion of "who is allowed to
 * call it".
 */
export async function listOpenDisputes(db: Db): Promise<AdminDisputeListItem[]> {
  const candidates = await getReconcilableBookings(db);
  if (candidates.length === 0) return [];

  const candidateBookings = candidates.map((candidate) => candidate.booking);
  const lifecycleByBooking = await getEscrowLifecycleForBookings(db, candidateBookings);
  const disputedBookings = candidateBookings.filter((booking) => lifecycleByBooking.get(booking.id)?.action === "disputed");
  if (disputedBookings.length === 0) return [];

  const openingByBooking = await getEscrowDisputeOpeningsForBookings(
    db,
    disputedBookings.map((booking) => booking.id),
  );

  const providerIds = [...new Set(disputedBookings.map((booking) => booking.providerProfileId))];
  const profiles = await Promise.all(providerIds.map((id) => getProviderProfileById(db, id)));
  const profileById = new Map(profiles.filter((profile): profile is NonNullable<typeof profile> => Boolean(profile)).map((profile) => [profile.id, profile]));

  const slotIds = [...new Set(disputedBookings.map((booking) => booking.slotId).filter((id): id is string => id !== null))];
  const slots = await Promise.all(slotIds.map((id) => getSlotById(db, id)));
  const slotById = new Map(slots.filter((slot): slot is NonNullable<typeof slot> => Boolean(slot)).map((slot) => [slot.id, slot]));

  return disputedBookings.map((booking) => {
    const opening = openingByBooking.get(booking.id);
    const matchesCurrentContract = opening !== undefined && opening.contractId === booking.escrowContractId;
    const profile = profileById.get(booking.providerProfileId);
    const slot = booking.slotId ? slotById.get(booking.slotId) : undefined;
    return {
      bookingId: booking.id,
      contractId: booking.escrowContractId as string,
      openedByWallet: matchesCurrentContract ? opening.openedByWallet : "",
      openedByRole: matchesCurrentContract ? (opening.openedByRole ?? undefined) : undefined,
      reason: matchesCurrentContract ? opening.reason : "unknown",
      suggestedOutcome: matchesCurrentContract ? (opening.suggestedOutcome ?? undefined) : undefined,
      amount: { amount: booking.depositAmount, asset: ASSET },
      provider: profile
        ? { id: profile.id, displayName: profile.displayName, title: profile.title }
        : { id: booking.providerProfileId, displayName: "", title: "" },
      clientWalletAddress: booking.clientWalletAddress,
      slotStartsAt: slot?.startsAt ?? null,
      pendingAction: derivePendingAction(booking, "disputed"),
    };
  });
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

/**
 * Story 3.6: the provider-side sibling of {@link getBookingForClient} --
 * `complete`/`release` are provider-only actions, so a booking whose own
 * provider profile does not resolve to the caller's wallet is refused the
 * identical {@link BookingNotFoundError} every other ownership check in this
 * file gives (never revealing whether the booking exists at all).
 */
export async function getBookingForProvider(db: Db, bookingId: string, providerWalletAddress: string): Promise<BookingRow> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new BookingNotFoundError();
  }
  const providerAddress = await requireProviderAddress(db, booking);
  if (providerAddress !== providerWalletAddress) {
    throw new BookingNotFoundError();
  }
  return booking;
}

/**
 * Story 3.6: `dispute` may be opened by either side (the client, as
 * approver, or the provider) -- this resolves "does this wallet own either
 * role on this booking", returning which one it is so the caller can pass
 * the right `signerAddress` to the adapter. Anyone else gets the same
 * {@link BookingNotFoundError} every other ownership check gives.
 */
export async function getBookingForClientOrProvider(
  db: Db,
  bookingId: string,
  walletAddress: string,
): Promise<{ booking: BookingRow; role: "client" | "provider" }> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new BookingNotFoundError();
  }
  if (booking.clientWalletAddress === walletAddress) {
    return { booking, role: "client" };
  }
  const providerAddress = await requireProviderAddress(db, booking);
  if (providerAddress === walletAddress) {
    return { booking, role: "provider" };
  }
  throw new BookingNotFoundError();
}

/**
 * Story 3.6 (review round): which of the five Story 3.6 actions this
 * booking has a signed transaction already relayed for, but whose own
 * chain-derived lifecycle has not yet moved past it -- `null` when no
 * action is pending. Checked in this priority order (dispute first: it can
 * be raised from any state, so a pending dispute matters more than whatever
 * else was also mid-flight): `dispute` (submitted, lifecycle not yet
 * `"disputed"`), `resolve` (submitted, lifecycle still `"disputed"`),
 * `release` (submitted, lifecycle still `"approved"`), `approve` (submitted,
 * lifecycle still `"funded"`/`"completed"`), `complete` (submitted,
 * lifecycle still `"funded"`). Shared by `getBookingView` and the two list
 * builders below so the three routes can never derive a different answer
 * for the same booking.
 */
function derivePendingAction(booking: BookingRow, lifecycleAction: EscrowLifecycleAction | undefined): EscrowActionKind | null {
  if (booking.escrowDisputeSubmittedAt !== null && lifecycleAction !== "disputed") return "dispute";
  if (booking.escrowResolveSubmittedAt !== null && lifecycleAction === "disputed") return "resolve";
  if (booking.escrowReleaseSubmittedAt !== null && lifecycleAction === "approved") return "release";
  if (booking.escrowApproveSubmittedAt !== null && (lifecycleAction === "funded" || lifecycleAction === "completed")) return "approve";
  if (booking.escrowCompleteSubmittedAt !== null && lifecycleAction === "funded") return "complete";
  return null;
}

export interface BookingView {
  id: string;
  escrowState: BookingRow["escrowState"];
  /** The finer lifecycle label Epic 3's UI needs (Story 2.6's
   * `getEscrowLifecycle`) -- `undefined` fields when nothing has been
   * recorded yet. */
  lifecycle: { contractId?: string; action?: string; outcome?: DisputeOutcome };
  /** Story 3.6 (review round): see {@link derivePendingAction}. */
  pendingAction: EscrowActionKind | null;
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
    pendingAction: derivePendingAction(booking, lifecycle.action),
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
 * Story 3.6 (review round): who is submitting -- resolved once, here, from
 * the booking and Pactly's own admin config, so both the route and
 * {@link submitSignedTransaction} agree on it without re-deriving it twice.
 * `"resolver"` is a global role (Pactly's own dispute-resolver wallet,
 * `config.adminWallets` intersected with `config.trustlessWorkPlatformAddress`)
 * -- unlike `"client"`/`"provider"`, it is not itself a role *on this
 * booking*, so it is checked last, after ownership. A wallet holding none
 * of the three gets the same {@link BookingNotFoundError} every other
 * ownership check in this file gives.
 */
export type SubmitRole = "client" | "provider" | "resolver";

export async function resolveSubmitRole(db: Db, bookingId: string, walletAddress: string): Promise<{ booking: BookingRow; role: SubmitRole }> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new BookingNotFoundError();
  }
  if (booking.clientWalletAddress === walletAddress) {
    return { booking, role: "client" };
  }
  const providerAddress = await requireProviderAddress(db, booking);
  if (providerAddress === walletAddress) {
    return { booking, role: "provider" };
  }
  if (config.adminWallets.includes(walletAddress) && walletAddress === config.trustlessWorkPlatformAddress) {
    return { booking, role: "resolver" };
  }
  throw new BookingNotFoundError();
}

/** Story 3.6: every action past deploy/fund that stores its own `txHash` on
 * the booking row (see `db/bookings.ts`'s `EscrowActionKind`/
 * `setEscrowActionTxHash`) -- named here alongside `deploy`/`fund` so
 * {@link submitSignedTransaction} can match a signed envelope against every
 * hash Pactly has ever built for this booking, from one row, in one place. */
type CandidateActionKind = "deploy" | "fund" | EscrowActionKind;

function candidateActionHashes(booking: BookingRow): ReadonlyArray<{ kind: CandidateActionKind; hash: string | null }> {
  return [
    { kind: "deploy", hash: booking.escrowDeployTxHash },
    { kind: "fund", hash: booking.escrowFundTxHash },
    { kind: "complete", hash: booking.escrowCompleteTxHash },
    { kind: "approve", hash: booking.escrowApproveTxHash },
    { kind: "release", hash: booking.escrowReleaseTxHash },
    { kind: "dispute", hash: booking.escrowDisputeTxHash },
    { kind: "resolve", hash: booking.escrowResolveTxHash },
  ];
}

/**
 * Story 3.6 (review round): which action kinds each {@link SubmitRole} may
 * ever relay -- the client signs deploy/fund/approve (and a dispute, but
 * only the one *it itself* built: see the `"dispute"` special case below);
 * the provider signs complete/release (and, symmetrically, its own
 * dispute); the resolver signs only resolve. Never `"deploy"`/`"fund"` for
 * anyone but the client, never `"complete"`/`"release"` for anyone but the
 * provider, never `"resolve"` for anyone but the resolver.
 */
const ROLE_ALLOWED_KINDS: Record<SubmitRole, ReadonlySet<CandidateActionKind>> = {
  client: new Set<CandidateActionKind>(["deploy", "fund", "approve"]),
  provider: new Set<CandidateActionKind>(["complete", "release"]),
  resolver: new Set<CandidateActionKind>(["resolve"]),
};

/** A dispute's own hash may only be relayed by whichever role actually
 * built it (`booking.pendingDisputeOpenerRole`) -- a client cannot relay a
 * dispute the provider opened, and vice versa, even though both roles may
 * open *some* dispute. */
function isKindAllowedForRole(kind: CandidateActionKind, role: SubmitRole, booking: BookingRow): boolean {
  if (kind === "dispute") {
    return (role === "client" || role === "provider") && booking.pendingDisputeOpenerRole === role;
  }
  return ROLE_ALLOWED_KINDS[role].has(kind);
}

/**
 * Relays a signed transaction to Trustless Work, over the adapter's own
 * `submit` -- but only once this booking's own records confirm both that
 * the signed envelope actually is one Pactly built for it, *and* that the
 * caller's own resolved {@link SubmitRole} is the role that XDR was built
 * for (review round: previously client-only, which 404'd every provider
 * complete/release/dispute and every admin resolve). This decodes the
 * envelope, computes its own hash, and requires that hash to equal one of
 * the booking's own stored action hashes for a kind {@link isKindAllowedForRole}
 * grants this role; anything else is refused (typed {@link XdrMismatchError})
 * before the adapter is ever called.
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
 * here). On a dispute match, this is the one place `escrow_dispute_openings`
 * is ever written (review round: no longer at build time -- see
 * `openDispute`'s own doc comment): `suggestedOutcome` is computed fresh
 * against *this* call's own clock, never a possibly-stale build-time one.
 * On complete/approve/release/resolve, this records that action's own
 * `submittedAt` so a fresh build of the same action is refused
 * (`409 ACTION_PENDING`) until the reconciler observes it.
 */
export async function submitSignedTransaction(
  db: Db,
  bookingId: string,
  signedXdr: string,
  role: SubmitRole,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SubmitTransactionResult> {
  const booking = await requireBooking(db, bookingId);
  const hash = computeSignedTransactionHash(signedXdr);

  const match = candidateActionHashes(booking).find(
    (candidate) => candidate.hash !== null && candidate.hash.toLowerCase() === hash && isKindAllowedForRole(candidate.kind, role, booking),
  );
  if (!match) {
    throw new XdrMismatchError();
  }

  const result = await adapter.submit(signedXdr);

  if (match.kind === "deploy" && booking.escrowContractId && booking.escrowDeployTxHash) {
    await recordDeploySubmission(db, bookingId, booking.escrowContractId, booking.escrowDeployTxHash, now + HOLD_DURATION_SECONDS, now);
  } else if (match.kind === "dispute") {
    if (booking.escrowContractId && booking.pendingDisputeReason && booking.pendingDisputeOpenerWallet && booking.pendingDisputeOpenerRole) {
      const suggestedOutcome = computeSuggestedOutcome(booking.pendingDisputeReason, booking, now);
      await recordEscrowDisputeOpening(db, {
        bookingId,
        contractId: booking.escrowContractId,
        openedByWallet: booking.pendingDisputeOpenerWallet,
        openedByRole: booking.pendingDisputeOpenerRole,
        reason: booking.pendingDisputeReason,
        suggestedOutcome,
        txHash: hash,
        openedAt: now,
      });
    }
    await setEscrowActionSubmittedAt(db, bookingId, "dispute", now);
  } else if (match.kind === "complete" || match.kind === "approve" || match.kind === "release" || match.kind === "resolve") {
    await setEscrowActionSubmittedAt(db, bookingId, match.kind, now);
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

// ---------------------------------------------------------------------------
// Story 3.5: the two-sided status panel's own list reads
// (`GET /me/bookings`, `GET /me/provider/bookings`). Both share the same
// per-item shape and appointment-date sort (the spec's own "Always" rule);
// only the "whose summary" field differs -- a provider summary for the
// client's own list, the client wallet for the provider's own list.
// ---------------------------------------------------------------------------

export interface BookingListItemBase {
  id: string;
  /** UTC epoch seconds -- `null` only for a pre-3.4 booking with no
   * `slotId`. */
  slotStartsAt: number | null;
  deposit: Money;
  balance: Money;
  price: Money;
  escrowState: BookingRow["escrowState"];
  lifecycle: { contractId?: string; action?: string; outcome?: DisputeOutcome };
  /** Story 3.6 (review round): see `derivePendingAction`'s own doc comment. */
  pendingAction: EscrowActionKind | null;
  balanceState: BalanceState;
  cancelDeadline: number;
  contractId: string | null;
  holdExpiresAt: number | null;
  /** The AD-13 hold's own 10-minute window has passed with `escrowState`
   * still `null` -- the spec's own "Always" rule: "An expired, never-funded
   * hold is listed under 'Expired holds' (collapsed), never as a booking."
   * The frontend groups on this flag; the row itself is never dropped here
   * (Story 3.4's own double-sale note: an expired hold's escrow may still
   * reconcile later, so it must stay traceable from this list too). */
  isExpiredHold: boolean;
}

export interface ClientBookingListItem extends BookingListItemBase {
  provider: BookingProviderSummary;
}

export interface ProviderBookingListItem extends BookingListItemBase {
  /** The full wallet address -- shortened only at render time (the
   * frontend's own `shortenStellarId`, the same helper `EscrowProof` already
   * uses), never truncated here (this backend never invents a display
   * format; see `lib/money.ts`'s own equivalent discipline for amounts). */
  clientWalletAddress: string;
}

function isExpiredHoldRow(booking: BookingRow, now: number): boolean {
  return booking.escrowState === null && booking.holdExpiresAt !== null && booking.holdExpiresAt < now;
}

/** Upcoming appointments first, soonest first; then past ones, most recent
 * first -- the spec's own "Always" sort rule, shared by both lists. A
 * booking with no slot (a pre-3.4 row with no `slotId`) sorts after every
 * dated one, in whatever order it was read in among themselves. */
function compareByAppointmentDate(a: { slotStartsAt: number | null }, b: { slotStartsAt: number | null }, now: number): number {
  if (a.slotStartsAt === null && b.slotStartsAt === null) return 0;
  if (a.slotStartsAt === null) return 1;
  if (b.slotStartsAt === null) return -1;
  const aUpcoming = a.slotStartsAt >= now;
  const bUpcoming = b.slotStartsAt >= now;
  if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
  return aUpcoming ? a.slotStartsAt - b.slotStartsAt : b.slotStartsAt - a.slotStartsAt;
}

function toBookingListItemBase(
  booking: BookingRow,
  slotStartsAt: number | null,
  lifecycle: EscrowLifecycle | undefined,
  now: number,
): BookingListItemBase {
  return {
    id: booking.id,
    slotStartsAt,
    deposit: { amount: booking.depositAmount, asset: ASSET },
    balance: { amount: booking.balanceAmount, asset: ASSET },
    price: { amount: (BigInt(booking.depositAmount) + BigInt(booking.balanceAmount)).toString(), asset: ASSET },
    escrowState: booking.escrowState,
    lifecycle: { contractId: lifecycle?.contractId, action: lifecycle?.action, outcome: lifecycle?.outcome },
    pendingAction: derivePendingAction(booking, lifecycle?.action),
    balanceState: booking.balanceState,
    cancelDeadline: booking.cancelDeadline,
    contractId: booking.escrowContractId,
    holdExpiresAt: booking.holdExpiresAt,
    isExpiredHold: isExpiredHoldRow(booking, now),
  };
}

/**
 * `GET /me/bookings`: every booking the caller's own wallet is the client
 * on, across every provider (the spec's own "Always" rule), ordered by
 * appointment date. Isolation rests entirely on
 * {@link listBookingRowsForClient}'s own `WHERE client_wallet_address = ?`
 * -- this function never filters by anything else, so another wallet's rows
 * can never leak in here.
 */
export async function listBookingsForClient(
  db: Db,
  clientWalletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ClientBookingListItem[]> {
  const rows = await listBookingRowsForClient(db, clientWalletAddress);
  if (rows.length === 0) return [];

  const lifecycleByBooking = await getEscrowLifecycleForBookings(
    db,
    rows.map((row) => row.booking),
  );
  const providerIds = [...new Set(rows.map((row) => row.booking.providerProfileId))];
  const profiles = await Promise.all(providerIds.map((id) => getProviderProfileById(db, id)));
  const profileById = new Map(profiles.filter((profile): profile is NonNullable<typeof profile> => Boolean(profile)).map((profile) => [profile.id, profile]));

  const items: ClientBookingListItem[] = rows.map(({ booking, slotStartsAt }) => {
    const profile = profileById.get(booking.providerProfileId);
    return {
      ...toBookingListItemBase(booking, slotStartsAt, lifecycleByBooking.get(booking.id), now),
      provider: profile
        ? { id: profile.id, displayName: profile.displayName, title: profile.title }
        : { id: booking.providerProfileId, displayName: "", title: "" },
    };
  });
  items.sort((a, b) => compareByAppointmentDate(a, b, now));
  return items;
}

/**
 * `GET /me/provider/bookings`: every booking against the caller's own
 * provider profile -- resolved from the caller's own wallet, never a
 * caller-supplied id (the same discipline every other `/me/provider` route
 * already follows), so another provider's bookings can never be requested
 * through this function at all. Refuses {@link NotAProviderError} for a
 * wallet with no provider profile.
 */
export async function listBookingsForProvider(
  db: Db,
  providerWalletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderBookingListItem[]> {
  const profile = await getProviderProfileByWallet(db, providerWalletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const rows = await listBookingRowsForProvider(db, profile.id);
  if (rows.length === 0) return [];

  const lifecycleByBooking = await getEscrowLifecycleForBookings(
    db,
    rows.map((row) => row.booking),
  );

  const items: ProviderBookingListItem[] = rows.map(({ booking, slotStartsAt }) => ({
    ...toBookingListItemBase(booking, slotStartsAt, lifecycleByBooking.get(booking.id), now),
    clientWalletAddress: booking.clientWalletAddress,
  }));
  items.sort((a, b) => compareByAppointmentDate(a, b, now));
  return items;
}
