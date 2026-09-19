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

import { defaultEscrowAdapter, callTrustlessWork } from "../escrow/trustless-work/client.js";
import { getEscrowLifecycle, realListEscrows } from "../escrow/trustless-work/reconciler.js";
import type { DeployEscrowResult, EscrowAdapter, SubmitTransactionResult, UnsignedTransaction } from "../escrow/interface.js";
import {
  getBookingById,
  insertBooking,
  insertBookingHoldIfSlotFree,
  listPotentialDoubleSales,
  clearAbandonedEscrowContractId,
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
  /** The provider's other open slots on the same UTC calendar day as the
   * one that was just lost -- the spec's own `details.sameDaySlots`. */
  readonly sameDaySlots: number[];
  constructor(sameDaySlots: number[]) {
    super("That slot just went.");
    this.name = "SlotTakenError";
    this.sameDaySlots = sameDaySlots;
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
}

export interface HoldSlotResult {
  bookingId: string;
  holdExpiresAt: number;
  deposit: Money;
  balance: Money;
  price: Money;
  cancelDeadline: number;
  provider: BookingProviderSummary;
}

export interface HoldSlotDeps {
  /** Injectable clock (UTC epoch seconds) -- defaults to the real one. */
  now?: number;
  /** Overrides how the USDC token address is resolved -- defaults to the
   * real, cached anchor lookup (`anchor/usdc.ts`). */
  resolveUsdcAsset?: (options?: ResolveUsdcAssetOptions) => Promise<{ contractId: string }>;
}

/** The UTC calendar day `[start, end)` containing `startsAt` -- the window
 * `SLOT_TAKEN`'s `sameDaySlots` searches. UTC, not the client's own
 * timezone: the backend has no notion of the caller's timezone, only the
 * viewer's browser does (`frontend/src/lib/time.ts` renders the local
 * label); this is a best-effort "same day" for the alternatives list, not a
 * claim about the client's own wall clock. */
function utcDayRange(startsAt: number): { start: number; end: number } {
  const SECONDS_PER_DAY = 24 * 60 * 60;
  const start = Math.floor(startsAt / SECONDS_PER_DAY) * SECONDS_PER_DAY;
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
    const { start, end } = utcDayRange(input.slotStartsAt);
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
    provider: { id: profile.id, displayName: profile.displayName, title: profile.title },
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

/** Refuses {@link BookingHoldExpiredError} once `holdExpiresAt` has passed
 * with `escrowState` still `null`. A `null` `holdExpiresAt` (a booking
 * inserted before Story 3.4, or through the plain `createBookingHold`
 * helper) never expires -- there is nothing to compare against. Once
 * `escrowState` is set the hold is moot (the deposit already reconciled),
 * so this never fires for a booking past that point either. */
function requireHoldNotExpired(booking: BookingRow, now: number): void {
  if (booking.escrowState === null && booking.holdExpiresAt !== null && booking.holdExpiresAt < now) {
    throw new BookingHoldExpiredError();
  }
}

/** Confirms whether `contractId` actually exists on Trustless Work's own
 * read model -- used only to decide whether an already-persisted
 * `contractId` with no stored deploy XDR (an abandoned deploy from before
 * this story ever supported storing one, or a legacy/test row) may be
 * safely rebuilt (Design Notes: "Why retry reuses the stored deploy XDR").
 * Defaults to a real `listEscrows({contractIds:[contractId]})` call through
 * the reconciler's own read seam, translated the same way every other
 * adapter call is (AC5). */
async function defaultContractExistsOnChain(contractId: string): Promise<boolean> {
  const listEscrows = realListEscrows();
  const page = await callTrustlessWork(() => listEscrows({ contractIds: [contractId], limit: 1 }));
  return page.data.length > 0;
}

export interface LockDepositDeps {
  /** Injectable clock (UTC epoch seconds) -- defaults to the real one. */
  now?: number;
  contractExistsOnChain?: (contractId: string) => Promise<boolean>;
}

/**
 * Builds the unsigned deploy XDR for an already-held booking and persists
 * the escrow's predicted `contractId` -- once, ever, per booking (unless
 * that deploy is later confirmed abandoned -- see below). Replaces the old
 * direct `chain.createBooking` call with the vendor-neutral `EscrowAdapter`,
 * and no longer also builds `fund` in the same call (see this module's own
 * top doc comment). The client address always comes from the booking's own
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
 * **Retry, and abandoned-deploy recovery (Story 3.4, Design Notes: "Why
 * retry reuses the stored deploy XDR").** When a `contractId` is already
 * persisted: if this booking also has a stored `escrowDeployXdr`, the exact
 * same `{contractId, deploy}` is returned again, with no new adapter call --
 * a declined wallet signature must be retryable within the hold, and Story
 * 2.6 made the write-once guard cover overwriting a *landed* deploy, not
 * retrying an unsigned one. When no XDR is stored (a pre-3.4 row, or one a
 * test seeded directly), this asks Trustless Work's own read model whether
 * the old `contractId` actually exists; if it does, this refuses (typed
 * {@link BookingEscrowStateError}) rather than risk a second, competing
 * escrow. If it does not, the stale `contractId` is cleared (conditionally,
 * only if nothing changed underneath this check) and a fresh deploy is
 * built.
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
    if (booking.escrowDeployXdr) {
      // Retry after a declined (or lost) signature: the same escrow, the
      // same unsigned XDR, never a second deploy for this booking.
      return {
        contractId: booking.escrowContractId,
        deploy: { contractId: booking.escrowContractId, unsignedXdr: booking.escrowDeployXdr, txHash: booking.escrowContractId },
      };
    }
    const contractExistsOnChain = deps.contractExistsOnChain ?? defaultContractExistsOnChain;
    const exists = await contractExistsOnChain(booking.escrowContractId);
    if (exists) {
      throw new BookingEscrowStateError(
        `Booking "${bookingId}" already has a persisted escrow contractId with no stored deploy XDR to retry, and the contract exists on chain; lockDeposit refuses to rebuild it`,
      );
    }
    // Clears the stale contractId so the recursive call below builds a
    // fresh deploy. If this write lost a race (something else changed the
    // row between the read above and here -- a fund landed, the reconciler
    // moved it on), `cleared` is simply `false` and the row is left alone;
    // either way, re-reading from a clean call lets the guards at the top
    // of this same function decide from the row's actual current state,
    // rather than trusting the now-possibly-stale snapshot this call
    // started with.
    await clearAbandonedEscrowContractId(db, bookingId, booking.escrowContractId);
    return lockDeposit(db, bookingId, adapter, deps);
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
  await updateEscrowContractId(db, bookingId, deployResult.contractId, deployResult.unsignedXdr);

  return { contractId: deployResult.contractId, deploy: deployResult };
}

export interface FundDepositDeps {
  now?: number;
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
 * Refused (typed {@link BookingHoldExpiredError}) once the hold has expired
 * with `escrowState` still `null`.
 */
export async function fundDeposit(
  db: Db,
  bookingId: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  deps: FundDepositDeps = {},
): Promise<UnsignedTransaction> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const booking = await requireBooking(db, bookingId);
  if (!booking.escrowContractId) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" has no persisted escrow contractId; call lockDeposit first`);
  }
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has escrow_state "${booking.escrowState}"; cannot fund again`);
  }
  requireHoldNotExpired(booking, now);

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

/**
 * Relays a client-signed transaction to Trustless Work, over the adapter's
 * own `submit`. Never checks the hold's expiry (the spec's own "Never" rule:
 * "Submit is allowed after expiry, because a transaction the client already
 * signed must still land and be reconciled") -- and never itself writes
 * `escrow_state` (AD-1); the reconciler is still the only writer, once it
 * reads this transaction's evidence back out of Trustless Work's own read
 * model.
 */
export async function submitSignedTransaction(
  bookingId: string,
  signedXdr: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<SubmitTransactionResult> {
  void bookingId; // kept as a parameter for symmetry with every other booking-scoped call and for future auditing, though `submit` itself is booking-agnostic (a signed XDR names its own contract).
  return adapter.submit(signedXdr);
}

/**
 * Story 3.4's hold-expiry runner tick: a read-only sweep that logs the
 * double-sale risk the spec's own Design Notes name ("A slot freed from an
 * expired hold whose escrow later reconciles as funded is logged as an
 * anomaly") -- an expired hold whose deploy is still in flight
 * (`escrowContractId` set, `escrowState` still `null`) on a slot some other
 * active booking has since re-held. Writes nothing; the actual freeing of a
 * slot happens implicitly, at the next `holdSlot` call's own atomic insert
 * (`insertBookingHoldIfSlotFree`), not here.
 */
export function expireHolds(db: Db, now: number = Math.floor(Date.now() / 1000), log: (message: string) => void = console.error): number {
  const potentialDoubleSales = listPotentialDoubleSales(db, now);
  for (const risk of potentialDoubleSales) {
    log(
      `[hold-expiry] anomaly: booking ${risk.bookingId}'s hold expired with escrow ${risk.contractId} still unconfirmed, ` +
        `and slot ${risk.slotId} has since been re-held by another booking -- watch for a double-sale if ${risk.contractId} funds`,
    );
  }
  return potentialDoubleSales.length;
}
