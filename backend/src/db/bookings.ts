/**
 * The only place SQL touches the `bookings` table. `updateEscrowState` is
 * called from exactly one place in the whole codebase --
 * `../chain/event-worker.ts` -- which is what AD-1/AD-3 mean in practice:
 * nothing else may write `escrow_state`.
 */
import { and, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";

import type { Db, DbOrTx } from "./client.js";
import {
  availabilitySlots,
  bookings,
  providerProfiles,
  type BalanceState,
  type DisputeOpenerRole,
  type DisputeReason,
  type EscrowState,
} from "./schema.js";

/** `escrow_state` values the reconciler must never move a booking past --
 * once here, a booking is excluded from every future reconciliation poll
 * (AC4's "for bookings whose escrow_state is not terminal"). */
export const TERMINAL_ESCROW_STATES: readonly EscrowState[] = ["released", "refunded"];

export interface NewBooking {
  id: string;
  providerProfileId: string;
  clientWalletAddress: string;
  tokenAddress: string;
  depositAmount: string;
  balanceAmount?: string;
  cancelDeadline: number;
  balanceState?: BalanceState;
  /** Story 3.4 (AD-13): the slot this booking holds. `undefined` only for a
   * pre-3.4 caller (existing tests) -- a real hold always sets this. */
  slotId?: string;
  /** Story 3.4 (AD-13): the hold's own expiry, UTC epoch seconds.
   * `undefined` only for a pre-3.4 caller. */
  holdExpiresAt?: number;
  createdAt: number;
}

export type BookingRow = typeof bookings.$inferSelect;

/** Writes a booking's initial row -- before any chain call, per AD-13: the
 * backend's hold generates the id and this row exists so the event worker
 * has something to mirror state onto once the chain confirms it. Never
 * sets `escrowState`; it starts `null` and stays that way until the event
 * worker processes this booking's first event.
 *
 * Story 3.4: a real slot hold never calls this directly -- it goes through
 * {@link insertBookingHoldIfSlotFree}, whose own single `INSERT ... SELECT
 * ... WHERE NOT EXISTS` statement is what actually enforces "at most one
 * active booking per slot" in SQL. This function stays the plain,
 * unconditional insert existing tests (and `seed/demo.ts`) already rely on. */
export async function insertBooking(db: Db, values: NewBooking): Promise<void> {
  await db.insert(bookings).values({
    id: values.id,
    providerProfileId: values.providerProfileId,
    clientWalletAddress: values.clientWalletAddress,
    tokenAddress: values.tokenAddress,
    depositAmount: values.depositAmount,
    balanceAmount: values.balanceAmount ?? "0",
    cancelDeadline: values.cancelDeadline,
    balanceState: values.balanceState ?? "unpaid",
    slotId: values.slotId,
    holdExpiresAt: values.holdExpiresAt,
    createdAt: values.createdAt,
  });
}

/**
 * The AD-13 slot hold's own write path (Story 3.4): a single `INSERT ...
 * SELECT ... WHERE NOT EXISTS` statement, so "a slot has at most one active
 * booking" (the spec's own "Always" rule) is enforced by SQLite itself, in
 * one atomic statement, never by a separate JS-level check-then-insert that
 * a second concurrent caller could interleave with. "Active" means a
 * non-expired hold (`hold_expires_at > now`) or a booking whose
 * `escrow_state` is already non-null (a locked/released/refunded booking
 * never frees its slot merely because its own hold's clock ran out).
 *
 * Returns `true` when the row was actually inserted (the slot was free),
 * `false` when another active booking already holds this exact `slotId` --
 * the caller (`services/booking.ts`'s `holdSlot`) turns a `false` into the
 * `409 SLOT_TAKEN` response, never a raw constraint error.
 */
export async function insertBookingHoldIfSlotFree(
  db: Db,
  values: NewBooking & { slotId: string; holdExpiresAt: number },
  now: number,
): Promise<boolean> {
  const result = db.run(sql`
    INSERT INTO bookings (
      id, provider_profile_id, client_wallet_address, token_address,
      deposit_amount, balance_amount, cancel_deadline, slot_id, hold_expires_at,
      balance_state, created_at
    )
    SELECT
      ${values.id}, ${values.providerProfileId}, ${values.clientWalletAddress}, ${values.tokenAddress},
      ${values.depositAmount}, ${values.balanceAmount ?? "0"}, ${values.cancelDeadline}, ${values.slotId}, ${values.holdExpiresAt},
      ${values.balanceState ?? "unpaid"}, ${values.createdAt}
    WHERE NOT EXISTS (
      SELECT 1 FROM bookings existing
      WHERE existing.slot_id = ${values.slotId}
        AND (
          (existing.escrow_state IS NOT NULL AND existing.escrow_state != 'refunded')
          OR (existing.escrow_state IS NULL AND existing.hold_expires_at > ${now})
        )
    )
  `);
  return result.changes > 0;
}

/** Same "active" definition as {@link insertBookingHoldIfSlotFree}'s own
 * `WHERE NOT EXISTS` clause (review follow-up: a refunded booking never
 * counts), for a caller (`holdSlot`) that needs to find -- not merely
 * refuse to duplicate -- the one active booking a wallet already holds on
 * a given slot. `undefined` when the wallet has no active booking there. */
export async function getActiveBookingForWalletAndSlot(
  db: Db,
  slotId: string,
  clientWalletAddress: string,
  now: number,
): Promise<BookingRow | undefined> {
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.slotId, slotId),
        eq(bookings.clientWalletAddress, clientWalletAddress),
        or(
          and(isNotNull(bookings.escrowState), ne(bookings.escrowState, "refunded")),
          and(isNull(bookings.escrowState), gt(bookings.holdExpiresAt, now)),
        ),
      ),
    )
    .limit(1);
  return rows[0];
}

/** How many *pending* holds (`escrow_state IS NULL`, not yet expired) a
 * wallet currently has open across every provider -- `holdSlot`'s own
 * per-wallet cap (review follow-up: caps abuse from one wallet opening
 * unlimited simultaneous holds). A booking that has already locked,
 * released or refunded is not "holding" anything anymore and never counts
 * here, regardless of how many of those a wallet has accumulated over
 * time. */
export async function countPendingHoldsForWallet(db: Db, clientWalletAddress: string, now: number): Promise<number> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.clientWalletAddress, clientWalletAddress), isNull(bookings.escrowState), gt(bookings.holdExpiresAt, now)));
  return rows.length;
}

export async function getBookingById(db: Db, id: string): Promise<BookingRow | undefined> {
  const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  return rows[0];
}

/** Story 3.6: every booking named in `ids`, in one query -- the admin
 * disputes list's own N+1 avoidance (same discipline as
 * `getEscrowLifecycleForBookings`). Empty input short-circuits to an empty
 * array. */
export async function getBookingsByIds(db: Db, ids: string[]): Promise<BookingRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(bookings).where(inArray(bookings.id, ids));
}

/** The event worker's own write path, as a synchronous call -- callable
 * either directly or (its reason for existing) from inside a
 * `db.transaction()` callback, which on better-sqlite3 must never `await`
 * (a transaction there is a real synchronous BEGIN/COMMIT wrapped around a
 * plain function call; an `await` inside would let the driver COMMIT
 * before the awaited write actually runs). Touches `escrowState` alone --
 * never `balanceState`, which is a different owner's column (AD-3).
 * Throws if `id` matches no row, rather than silently writing nothing. */
export function updateEscrowStateSync(db: DbOrTx, id: string, escrowState: EscrowState): void {
  const result = db.update(bookings).set({ escrowState }).where(eq(bookings.id, id)).run();
  if (result.changes === 0) {
    throw new TypeError(`No booking exists with id "${id}"`);
  }
}

/** The event worker's own write path. Touches `escrowState` alone -- never
 * `balanceState`, which is a different owner's column (AD-3). */
export async function updateEscrowState(db: Db, id: string, escrowState: EscrowState): Promise<void> {
  updateEscrowStateSync(db, id, escrowState);
}

/** Same as {@link updateEscrowStateSync}, except the write itself is
 * conditioned in SQL on the row not already being terminal -- `WHERE id = ?
 * AND (escrow_state IS NULL OR escrow_state NOT IN ('released',
 * 'refunded'))`. The reconciler's own in-memory terminal check
 * (`processEscrowRow`) reads a booking snapshot fetched once per batch, so
 * a second row for the same escrow processed later in that same batch
 * could otherwise regress an already-terminal booking (e.g.
 * `released` -> `locked`) before the first row's own write is even
 * visible to that stale snapshot. Returns `true` only when a row was
 * actually written -- `false` when the booking was already terminal (by
 * this point, not necessarily by the caller's own possibly-stale check) or
 * does not exist. */
export function updateEscrowStateIfNotTerminalSync(db: DbOrTx, id: string, escrowState: EscrowState): boolean {
  const result = db
    .update(bookings)
    .set({ escrowState })
    .where(
      and(
        eq(bookings.id, id),
        or(isNull(bookings.escrowState), notInArray(bookings.escrowState, [...TERMINAL_ESCROW_STATES])),
      ),
    )
    .run();
  return result.changes > 0;
}

/** The backend's own write path for the balance side of AD-3. Touches
 * `balanceState` alone -- never `escrowState`. Throws if `id` matches no
 * row, rather than silently writing nothing. */
export async function updateBalanceState(db: Db, id: string, balanceState: BalanceState): Promise<void> {
  const result = await db.update(bookings).set({ balanceState }).where(eq(bookings.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No booking exists with id "${id}"`);
  }
}

/** `services/booking.ts`'s `lockDeposit` write path: persists the escrow's
 * predicted `contractId` the moment the deploy XDR is built -- once, ever,
 * per booking. The write itself is conditioned in SQL (`WHERE id = ? AND
 * escrow_state IS NULL AND escrow_contract_id IS NULL`) so a second
 * `lockDeposit` can never silently overwrite a `contractId` whose deploy
 * (and possibly `fundDeposit`) may already have landed on chain -- doing so
 * would orphan whatever was actually funded, since every later call
 * (`fundDeposit`, the reconciler) only ever looks at the *current* column
 * value. Throws when the write did not happen, whether because `id` does
 * not exist, an `escrowState` is already recorded, or a `contractId` is
 * already persisted -- `services/booking.ts`'s own pre-check is expected to
 * have already ruled out the first two cases with a more specific error;
 * this is the defense against the same race in the small window between
 * that check and this write. */
export async function updateEscrowContractId(
  db: Db,
  id: string,
  contractId: string,
  /** Story 3.4: the unsigned deploy XDR built for this same `contractId`,
   * stored alongside it (same guarded write, same atomicity) so a retried
   * `lockDeposit` can return the identical XDR rather than deploying a
   * second, competing escrow (Design Notes: "Why retry reuses the stored
   * deploy XDR"). `undefined` for a caller that has no XDR to store (kept
   * optional so every pre-3.4 call site -- and every test that seeds an
   * "abandoned deploy with nothing stored" row -- still compiles). */
  unsignedXdr?: string,
  /** Review follow-up: the Trustless-Work-returned `txHash` for this same
   * deploy XDR, stored so `submitSignedTransaction` can match a signed
   * envelope's own computed hash against it before ever relaying it. */
  txHash?: string,
): Promise<void> {
  const result = await db
    .update(bookings)
    .set({ escrowContractId: contractId, escrowDeployXdr: unsignedXdr ?? null, escrowDeployTxHash: txHash ?? null })
    .where(and(eq(bookings.id, id), isNull(bookings.escrowState), isNull(bookings.escrowContractId)));
  if (result.changes === 0) {
    throw new TypeError(
      `Could not persist escrowContractId for booking "${id}": it does not exist, or already has an escrow_state or a contractId`,
    );
  }
}

/**
 * Clears a persisted `contractId` (and its stored deploy XDR/txHash, if
 * any) so `lockDeposit` can rebuild a fresh deploy on an explicit
 * `rebuild: true` request. Conditioned on the row still naming the exact
 * `contractId` the caller read, on no deploy having been submitted yet
 * (`deploy_submitted_at IS NULL` -- once a signed deploy has actually been
 * relayed, rebuilding would abandon money in flight), and on `escrow_state`
 * still being `null`. Returns `false` on any of those no longer holding
 * (a race with a concurrent submit or the reconciler) rather than throwing
 * -- the caller re-reads the booking and proceeds from its current state.
 */
export async function clearUnsubmittedEscrowContractId(db: Db, id: string, expectedContractId: string): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ escrowContractId: null, escrowDeployXdr: null, escrowDeployTxHash: null })
    .where(
      and(
        eq(bookings.id, id),
        eq(bookings.escrowContractId, expectedContractId),
        isNull(bookings.escrowState),
        isNull(bookings.deploySubmittedAt),
      ),
    );
  return result.changes > 0;
}

/**
 * Records that a signed deploy transaction matching `expectedTxHash` was
 * successfully relayed, and extends the hold to `newHoldExpiresAt` (ten
 * minutes from the moment of submission -- the client has now committed a
 * real signature and needs time to complete funding). Conditioned on the
 * row still naming the exact `contractId`/`txHash` the caller matched
 * against, on no earlier submission already recorded (write-once: a
 * resubmit of the identical signed envelope is harmless but must not keep
 * re-extending the hold indefinitely), and on `escrow_state` still being
 * `null`. Returns `false` -- never throws -- when any of those no longer
 * holds; the caller (`submitSignedTransaction`) still relays the
 * transaction either way, since a `false` here only means "already
 * recorded" or "already moved past this", not a reason to refuse the
 * relay itself.
 */
export async function recordDeploySubmission(
  db: Db,
  id: string,
  expectedContractId: string,
  expectedTxHash: string,
  newHoldExpiresAt: number,
  submittedAt: number,
): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ deploySubmittedAt: submittedAt, holdExpiresAt: newHoldExpiresAt })
    .where(
      and(
        eq(bookings.id, id),
        eq(bookings.escrowContractId, expectedContractId),
        eq(bookings.escrowDeployTxHash, expectedTxHash),
        isNull(bookings.deploySubmittedAt),
        isNull(bookings.escrowState),
      ),
    );
  return result.changes > 0;
}

/** `services/booking.ts`'s `fundDeposit` write path: stores the
 * Trustless-Work-returned `txHash` for the fund XDR just built, so
 * `submitSignedTransaction` can match a signed envelope against it.
 * Unlike the deploy XDR, funding is not write-once -- each call simply
 * overwrites whatever was stored before, since only the most recently
 * built fund transaction is ever the one worth signing. */
export async function setEscrowFundTxHash(db: Db, id: string, txHash: string): Promise<void> {
  await db.update(bookings).set({ escrowFundTxHash: txHash }).where(eq(bookings.id, id));
}

/** Story 3.6: every action past deploy/fund shares this one write path --
 * stores the just-built unsigned XDR's own `txHash` on the booking so
 * `submitSignedTransaction`'s hash-matching rule (3.4's submit allow-list)
 * extends to it. Not write-once, unlike the deploy XDR: a declined
 * signature must still be retryable, and each call simply overwrites
 * whatever was stored before -- only the most recently built transaction
 * for that action is ever the one worth signing. */
export type EscrowActionKind = "complete" | "approve" | "release" | "dispute" | "resolve";

export async function setEscrowActionTxHash(db: Db, id: string, action: EscrowActionKind, txHash: string): Promise<void> {
  switch (action) {
    case "complete":
      await db.update(bookings).set({ escrowCompleteTxHash: txHash }).where(eq(bookings.id, id));
      return;
    case "approve":
      await db.update(bookings).set({ escrowApproveTxHash: txHash }).where(eq(bookings.id, id));
      return;
    case "release":
      await db.update(bookings).set({ escrowReleaseTxHash: txHash }).where(eq(bookings.id, id));
      return;
    case "dispute":
      await db.update(bookings).set({ escrowDisputeTxHash: txHash }).where(eq(bookings.id, id));
      return;
    case "resolve":
      await db.update(bookings).set({ escrowResolveTxHash: txHash }).where(eq(bookings.id, id));
      return;
  }
}

/**
 * Story 3.6 (review round): the pending dispute's own build-time record --
 * "last builder wins", so a caller opening a second dispute before ever
 * submitting the first simply overwrites this row's own hash, reason,
 * opener wallet and opener role together. Never itself writes
 * `escrow_dispute_openings` -- that only happens once a signed transaction
 * matching this same hash is actually relayed ({@link setEscrowActionTxHash}'s
 * `"dispute"` case is not used for this column any more; this function is
 * `openDispute`'s one write path instead).
 */
export interface PendingDispute {
  txHash: string;
  reason: DisputeReason;
  openerWallet: string;
  openerRole: DisputeOpenerRole;
}

export async function setPendingDispute(db: Db, id: string, pending: PendingDispute): Promise<void> {
  await db
    .update(bookings)
    .set({
      escrowDisputeTxHash: pending.txHash,
      pendingDisputeReason: pending.reason,
      pendingDisputeOpenerWallet: pending.openerWallet,
      pendingDisputeOpenerRole: pending.openerRole,
    })
    .where(eq(bookings.id, id));
}

/**
 * Story 3.6 (review round): records that a signed transaction for `action`
 * was actually relayed -- mirrors `recordDeploySubmission`'s role for the
 * deploy step, one column per action kind. `services/booking.ts` reads this
 * back (per action, against the reconciler's own current lifecycle) to
 * refuse building the *same* action again while it is already awaiting
 * chain confirmation (`409 ACTION_PENDING`), and to compute `pendingAction`
 * for `GET /bookings/:id` and the two list routes.
 */
export async function setEscrowActionSubmittedAt(db: Db, id: string, action: EscrowActionKind, submittedAt: number): Promise<void> {
  switch (action) {
    case "complete":
      await db.update(bookings).set({ escrowCompleteSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
    case "approve":
      await db.update(bookings).set({ escrowApproveSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
    case "release":
      await db.update(bookings).set({ escrowReleaseSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
    case "dispute":
      await db.update(bookings).set({ escrowDisputeSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
    case "resolve":
      await db.update(bookings).set({ escrowResolveSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
  }
}

/** Story 3.7's own submit-binding write path (mirrors
 * `updateEscrowContractId`'s `escrowDeployXdr`/`escrowDeployTxHash` pair):
 * stores the hash of the plain Stellar USDC payment `buildBalancePayment`
 * just built, so `submitBalancePayment` can later refuse anything whose own
 * computed hash does not match it. Not write-once -- a declined signature
 * must still be retryable, so a later `buildBalancePayment` call simply
 * overwrites whatever was stored before. */
export async function setBalancePaymentBuiltHash(db: Db, id: string, hash: string): Promise<void> {
  await db.update(bookings).set({ balancePaymentBuiltHash: hash }).where(eq(bookings.id, id));
}

/**
 * Story 3.7's own write path for "paid through Pactly": moves
 * `balanceState` to `"paid_platform"` and stores the on-chain `txHash`, in
 * one write, conditioned on `balanceState` still being `"unpaid"` (the same
 * defense-in-depth shape as `updateEscrowContractId`'s own guarded write) so
 * a race -- the provider marking cash paid at the same moment a client's
 * platform payment confirms -- can never silently overwrite whichever write
 * landed first. Returns `false` (never throws) when the row was no longer
 * `"unpaid"`; the caller's own service-level check already refused the
 * request before this point in the ordinary case, so this is only the last
 * line of defense against a genuine race. */
export async function markBalancePaidPlatform(db: Db, id: string, txHash: string): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ balanceState: "paid_platform", balancePaymentTxHash: txHash })
    .where(and(eq(bookings.id, id), eq(bookings.balanceState, "unpaid")));
  return result.changes > 0;
}

/**
 * Story 3.4's hold-expiry tick (`runner.ts`): every booking whose hold has
 * expired with an escrow deploy still in flight (`escrowContractId` set,
 * `escrowState` still `null`) *and* whose slot has since been re-held by a
 * different active booking -- the double-sale risk the story's own Design
 * Notes name ("A slot freed from an expired hold whose escrow later
 * reconciles as funded is logged as an anomaly"). Both rows are left
 * exactly as they are; this is a read-only detector for the runner to log,
 * never a writer.
 */
export interface PotentialDoubleSale {
  bookingId: string;
  contractId: string;
  slotId: string;
}

export function listPotentialDoubleSales(db: Db, now: number): PotentialDoubleSale[] {
  // "Expired" is `<= now` everywhere in this codebase (matches
  // `services/booking.ts`'s `requireHoldNotExpired`); "active" is `> now`.
  // A row exactly at `now` is expired, never both.
  const rows = db.all<{ booking_id: string; contract_id: string; slot_id: string }>(sql`
    SELECT b.id AS booking_id, b.escrow_contract_id AS contract_id, b.slot_id AS slot_id
    FROM bookings b
    WHERE b.escrow_state IS NULL
      AND b.escrow_contract_id IS NOT NULL
      AND b.slot_id IS NOT NULL
      AND b.hold_expires_at IS NOT NULL
      AND b.hold_expires_at <= ${now}
      AND EXISTS (
        SELECT 1 FROM bookings other
        WHERE other.slot_id = b.slot_id
          AND other.id != b.id
          AND (
            (other.escrow_state IS NOT NULL AND other.escrow_state != 'refunded')
            OR (other.escrow_state IS NULL AND other.hold_expires_at > ${now})
          )
      )
  `);
  return rows.map((row) => ({ bookingId: row.booking_id, contractId: row.contract_id, slotId: row.slot_id }));
}

/**
 * Review follow-up: a second, more general double-sale detector alongside
 * {@link listPotentialDoubleSales} -- two *distinct* bookings sharing the
 * same `slot_id` where at least one already has a non-null, non-`refunded`
 * `escrow_state` (a real, committed booking) and the other is *also*
 * locked/released/refunded or still an actively-held pending hold. This
 * should never happen given {@link insertBookingHoldIfSlotFree}'s own
 * atomic guarantee -- it exists as a safety-net sweep, not a path anything
 * is expected to hit. Returns one row per ordered pair (so a caller can
 * dedupe by an unordered pair key itself, which `expireHolds` does, to log
 * each conflict once rather than twice).
 */
export interface ConflictingBookingPair {
  slotId: string;
  bookingIdA: string;
  bookingIdB: string;
}

export function listConflictingSlotBookings(db: Db, now: number): ConflictingBookingPair[] {
  const rows = db.all<{ slot_id: string; booking_a: string; booking_b: string }>(sql`
    SELECT b1.slot_id AS slot_id, b1.id AS booking_a, b2.id AS booking_b
    FROM bookings b1
    JOIN bookings b2 ON b1.slot_id = b2.slot_id AND b1.id != b2.id
    WHERE b1.slot_id IS NOT NULL
      AND b1.escrow_state IS NOT NULL
      AND b1.escrow_state != 'refunded'
      AND (
        (b2.escrow_state IS NOT NULL AND b2.escrow_state != 'refunded')
        OR (b2.escrow_state IS NULL AND b2.hold_expires_at > ${now})
      )
  `);
  return rows.map((row) => ({ slotId: row.slot_id, bookingIdA: row.booking_a, bookingIdB: row.booking_b }));
}

/** One booking the reconciler is allowed to poll, plus the provider wallet
 * its escrow's `receiver`/`serviceProviders`/`releaseSigners` roles must
 * name (Story 1.8's role map) -- resolved once here so
 * `reconciler.ts` never re-joins `provider_profiles` itself. */
export interface ReconcilableBooking {
  booking: BookingRow;
  providerAddress: string;
}

/**
 * Every booking the reconciler may poll this run (AC4, amended
 * 2026-09-19): a persisted `escrowContractId` and an `escrowState` that is
 * not yet terminal (`released`/`refunded`) -- once a booking reaches a
 * terminal state it is never polled again, which is what keeps a stale or
 * out-of-order read-model row from ever regressing it (the I/O matrix's
 * "stale or out-of-order row" guard starts here, at the query itself, not
 * only in the reconciler's own per-row logic).
 */
export async function getReconcilableBookings(db: Db): Promise<ReconcilableBooking[]> {
  const rows = await db
    .select({ booking: bookings, providerAddress: providerProfiles.walletAddress })
    .from(bookings)
    .innerJoin(providerProfiles, eq(bookings.providerProfileId, providerProfiles.id))
    .where(
      and(
        isNotNull(bookings.escrowContractId),
        // `escrowState` starts `null` (before the reconciler's first
        // confirmed transition) and must stay pollable then -- SQL's
        // three-valued logic means a plain `NOT IN` silently excludes NULL
        // rows, which would make the very first "funded" transition
        // unreachable for every booking.
        or(isNull(bookings.escrowState), notInArray(bookings.escrowState, [...TERMINAL_ESCROW_STATES])),
      ),
    );
  return rows.map((row) => ({ booking: row.booking, providerAddress: row.providerAddress }));
}

// ---------------------------------------------------------------------------
// Story 3.5: the two-sided status panel's own list reads. Each pairs a
// booking row with its own slot's `startsAt` (`null` for a pre-3.4 booking
// with no `slotId`), via a `LEFT JOIN` so a booking is never dropped just
// because it has no slot -- `services/booking.ts` is where the appointment-
// date ordering and the per-item view shape actually get built; these two
// functions are only the SQL that scopes a list to one wallet's own rows.
// ---------------------------------------------------------------------------

export interface BookingWithSlot {
  booking: BookingRow;
  slotStartsAt: number | null;
}

/** `GET /me/bookings`'s own read: every booking `clientWalletAddress` is the
 * client on, across every provider (the spec's own "Always" rule) -- this
 * `WHERE` clause is the one thing standing between one client's list and
 * another's (the spec's own "Isolation" row). */
export async function listBookingRowsForClient(db: Db, clientWalletAddress: string): Promise<BookingWithSlot[]> {
  const rows = await db
    .select({ booking: bookings, slotStartsAt: availabilitySlots.startsAt })
    .from(bookings)
    .leftJoin(availabilitySlots, eq(bookings.slotId, availabilitySlots.id))
    .where(eq(bookings.clientWalletAddress, clientWalletAddress));
  return rows.map((row) => ({ booking: row.booking, slotStartsAt: row.slotStartsAt ?? null }));
}

/** `GET /me/provider/bookings`'s own read: every booking against one
 * provider profile -- the caller resolves `providerProfileId` from their own
 * wallet first (`services/booking.ts`'s `listBookingsForProvider`), never
 * from a caller-supplied id, so another provider's bookings can never be
 * requested through this function at all. */
export async function listBookingRowsForProvider(db: Db, providerProfileId: string): Promise<BookingWithSlot[]> {
  const rows = await db
    .select({ booking: bookings, slotStartsAt: availabilitySlots.startsAt })
    .from(bookings)
    .leftJoin(availabilitySlots, eq(bookings.slotId, availabilitySlots.id))
    .where(eq(bookings.providerProfileId, providerProfileId));
  return rows.map((row) => ({ booking: row.booking, slotStartsAt: row.slotStartsAt ?? null }));
}
