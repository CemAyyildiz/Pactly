/**
 * The Trustless Work reconciler (AD-9), amended 2026-09-19 -- Story 2.6's
 * retarget of `chain/event-worker.ts` onto Trustless Work's escrow
 * read-model instead of Soroban `getEvents`. The only writer of
 * `bookings.escrow_state` for any Trustless-Work-backed booking (AD-1/AD-3);
 * every other module that touches a booking row leaves that column alone.
 *
 * **Why this does not poll `EscrowEvent.kind`.** The installed
 * `@trustless-work/escrow-js@1.0.0-beta.1`'s own types confirm
 * `EscrowEvent.kind` is a bare `string` -- the SDK defines no fixed event
 * vocabulary. A reconciler that branched on invented names (`"funded"`,
 * `"approved"`, ...) would silently drop every *real* event whose actual
 * name differs. Instead this reconciler derives a lifecycle transition
 * from an `EscrowSummary` read-model row's own typed fields -- `status`,
 * `balance`, `snapshot.dispute`, `snapshot.released`, milestone
 * `approvals` -- which the SDK does define, per the Design Notes' lifecycle
 * derivation table.
 *
 * **Why this does not discover escrows by `engagementId`.** `engagementId`
 * is a field anyone deploying an escrow can set to any value, including
 * another booking's id. This reconciler instead polls only the
 * `contractId`s Pactly
 * itself persisted on `bookings.escrow_contract_id` at deploy time
 * (`db/bookings.ts`'s `getReconcilableBookings`), via
 * `listEscrows({ contractIds })` -- and still cross-checks every returned
 * row's `engagementId`/roles/amount/trustline against its own booking
 * before trusting it (`checkEscrowMatchesBooking` below), since a
 * requested `contractId` could in principle still resolve to an escrow
 * whose *content* was never actually built for this booking.
 *
 * `runReconcilerOnce` is one batch: read every reconcilable booking's
 * persisted `contractId`, fetch their current read-model rows (chunked,
 * every keyset page followed), derive at most one lifecycle transition per
 * row, apply each at most once (deduped by `(contractId, lifecycleAction)`
 * in the same atomic dedupe-then-state-write transaction
 * `chain/event-worker.ts` established), and record a per-escrow
 * `lastLedgerSeq` watermark so a restart -- or a later poll that sees the
 * exact same snapshot -- never re-derives a row it has already processed.
 */
import {
  TrustlessWorkClient,
  type EscrowSummary,
  type ListEscrowsParams,
  type ListEscrowsResponse,
  type SingleReleaseEscrowSnapshot,
  type SingleReleaseMilestone,
} from "@trustless-work/escrow-js";

import { callTrustlessWork } from "./client.js";
import { EscrowConfigError, EscrowRequestError } from "./errors.js";
import { config } from "../../config.js";
import {
  getBookingById,
  getReconcilableBookings,
  updateEscrowStateIfNotTerminalSync,
  TERMINAL_ESCROW_STATES,
  type ReconcilableBooking,
} from "../../db/bookings.js";
import {
  insertEscrowProcessedEventIfNewSync,
  listEscrowProcessedEventsForBooking,
  listEscrowProcessedEventsForBookings,
  type EscrowProcessedEventRow,
} from "../../db/escrowProcessedEvents.js";
import { getEscrowWatermark, setEscrowWatermark } from "../../db/escrowReconcilerWatermarks.js";
import {
  getEscrowDisputeResolution,
  getEscrowDisputeResolutionsForBookings,
  type EscrowDisputeResolutionRow,
} from "../../db/escrowDisputeResolutions.js";
import type { BookingRow } from "../../db/bookings.js";
import type { Db, DbOrTx } from "../../db/client.js";
import type { DisputeOutcome, EscrowState } from "../../db/schema.js";

/**
 * The five lifecycle actions this story's amended I/O matrix names.
 * `resolved` is kept distinct from `released` (both can map to
 * `escrow_state = "released"`, via `pay-provider`) so `getEscrowLifecycle`
 * can tell Epic 3's "Released" apart from "Resolved" UX labels (Design
 * Notes: "Why lifecycle rows are finer than escrow_state").
 */
export const RECOGNIZED_LIFECYCLE_ACTIONS = ["funded", "approved", "disputed", "released", "resolved"] as const;
export type EscrowLifecycleAction = (typeof RECOGNIZED_LIFECYCLE_ACTIONS)[number];

/** Maps a recognized lifecycle action onto `bookings.escrow_state`'s three
 * values. `resolved` needs the recorded Pactly decision's own `outcome` to
 * know which of `refunded`/`released` it means -- the read-model shows
 * *that* a dispute resolved, never *to whom* the money went. */
export function escrowStateForLifecycleAction(action: EscrowLifecycleAction, outcome?: DisputeOutcome): EscrowState {
  switch (action) {
    case "funded":
    case "approved":
    case "disputed":
      return "locked";
    case "released":
      return "released";
    case "resolved":
      if (!outcome) {
        throw new TypeError('escrowStateForLifecycleAction("resolved", ...) requires an outcome');
      }
      return outcome === "refund-client" ? "refunded" : "released";
  }
}

/** Parses a human-decimal amount string (as the read-model returns amounts
 * -- SDK README: "Amounts on reads are human decimal strings") into
 * smallest units, using exact string/bigint arithmetic -- never
 * `Number(...)`, never a float. `undefined` for anything that is not a
 * plain non-negative decimal, or that carries more fractional digits than
 * the asset supports (`decimals`, fixed at 7 -- this codebase's own
 * established USDC convention, matching `client.ts`'s `ASSET_DECIMALS`). */
export function humanDecimalToSmallestUnits(value: string, decimals = 7): bigint | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const whole = match[1] as string;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return undefined;
  const paddedFraction = fraction.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + (paddedFraction === "" ? 0n : BigInt(paddedFraction));
}

function isMilestoneApproved(milestone: SingleReleaseMilestone | undefined): boolean {
  if (!milestone) return false;
  if (typeof milestone.status === "string" && milestone.status.toLowerCase() === "approved") return true;
  const approvals = milestone.approvals;
  if (approvals && typeof approvals.target === "number" && approvals.approvalCount >= approvals.target) return true;
  return false;
}

/** `true` when `value` is an array holding exactly one element equal to
 * `expected` -- the shape every array-valued V2 role must take for Pactly's
 * 1-to-1 role map (Boundaries & Constraints: "every array this story
 * constructs holds exactly one address per role"). */
function isSoleMember(value: readonly string[] | undefined, expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

/**
 * Cross-checks a read-model row against the booking its persisted
 * `contractId` names and against Pactly's own role map (Story 1.8),
 * per the Design Notes' lifecycle derivation table: `engagementId` = booking
 * id; `approvers` = `[client]`; `serviceProviders`/`releaseSigners`/
 * `receiver` = provider; `disputeResolvers`/`platform`/`admin` = Pactly's own
 * `platformAddress`; `snapshot.amount` = deposit; milestone 0's
 * `approvalsTarget` = 1; the trustline (`snapshot.trustline.contractId`,
 * falling back to the root `asset.contractId` when the snapshot's own field
 * is empty) = the booking's token. Returns a reason string on any mismatch,
 * `undefined` when the row may be trusted.
 *
 * Never throws on a malformed row (a missing `roles`/`milestones` reads as
 * a mismatch, not an exception) -- a single bad row must never abort the
 * whole reconciliation batch. Does throw a typed {@link EscrowConfigError}
 * for an empty `platformAddress`, since that is a real misconfiguration
 * this backend cannot reconcile *anything* through, not a per-row problem.
 */
export function checkEscrowMatchesBooking(
  booking: BookingRow,
  providerAddress: string,
  platformAddress: string,
  row: EscrowSummary,
): string | undefined {
  if (!platformAddress) {
    throw new EscrowConfigError(
      "TRUSTLESS_WORK_PLATFORM_ADDRESS is empty. Configure Pactly's own Stellar account before reconciling " +
        "escrow evidence (see .env.example).",
    );
  }
  if (row.type !== "single-release") {
    return `escrow type "${row.type}" is not single-release`;
  }
  if (row.engagementId !== booking.id) {
    return `engagementId "${row.engagementId}" does not match booking id "${booking.id}"`;
  }
  const snapshot = row.snapshot as SingleReleaseEscrowSnapshot | undefined;
  const roles = snapshot?.roles;
  if (!roles) {
    return "escrow snapshot carries no roles";
  }
  if (!isSoleMember(roles.approvers, booking.clientWalletAddress)) {
    return `approvers ${JSON.stringify(roles.approvers)} do not match the booking's client wallet "${booking.clientWalletAddress}"`;
  }
  if (!isSoleMember(roles.serviceProviders, providerAddress)) {
    return `serviceProviders ${JSON.stringify(roles.serviceProviders)} do not match the booking's provider wallet "${providerAddress}"`;
  }
  if (!isSoleMember(roles.releaseSigners, providerAddress)) {
    return `releaseSigners ${JSON.stringify(roles.releaseSigners)} do not match the booking's provider wallet "${providerAddress}"`;
  }
  if (roles.receiver !== providerAddress) {
    return `receiver "${roles.receiver}" does not match the booking's provider wallet "${providerAddress}"`;
  }
  if (!isSoleMember(roles.disputeResolvers, platformAddress)) {
    return `disputeResolvers ${JSON.stringify(roles.disputeResolvers)} do not match Pactly's own platform address`;
  }
  if (roles.platform !== platformAddress) {
    return `platform "${roles.platform}" does not match Pactly's own platform address`;
  }
  if (roles.admin !== platformAddress) {
    return `admin "${roles.admin}" does not match Pactly's own platform address`;
  }
  if (snapshot.milestones?.[0]?.approvalsTarget !== 1) {
    return `milestone 0's approvalsTarget "${snapshot.milestones?.[0]?.approvalsTarget}" is not 1`;
  }
  const snapshotAmount = humanDecimalToSmallestUnits(snapshot.amount);
  if (snapshotAmount === undefined || snapshotAmount !== BigInt(booking.depositAmount)) {
    return `escrow amount "${snapshot.amount}" does not match the booking's deposit amount "${booking.depositAmount}"`;
  }
  // A null/empty snapshot trustline contract falls back to the read-model
  // row's own resolved `asset.contractId` -- either one going unmatched
  // (including both being absent) is a mismatch, never silently skipped.
  const trustlineContractId = snapshot.trustline?.contractId ?? row.asset?.contractId;
  if (trustlineContractId !== booking.tokenAddress) {
    return `trustline contract "${trustlineContractId}" does not match the booking's token "${booking.tokenAddress}"`;
  }
  return undefined;
}

export type LifecycleDerivation =
  | { kind: "transition"; action: EscrowLifecycleAction; outcome?: DisputeOutcome }
  | { kind: "none" }
  | { kind: "mismatch"; reason: string }
  | { kind: "unresolved-decision" };

/**
 * The lifecycle derivation table itself (Design Notes, amended after
 * review), evaluated in order for one already-matched row: (1) a resolved
 * dispute, mapped through Pactly's own recorded decision -- balance is not
 * a condition here, since `dispute.resolved` is itself the read-model's own
 * signal, not something inferred from a zero balance (a third party
 * overfunding the escrow after resolution must never keep this stuck as
 * "unresolved"; `processEscrowRow` logs when the balance is unexpectedly
 * non-zero); (2) released; (3) an open dispute, and (3b) milestone 0's
 * approvals reached (not yet released) -- both require balance >= deposit,
 * since neither can honestly describe an escrow that was never actually
 * funded; (4) funded. Anything else derives no transition. Never called on
 * a row that failed {@link checkEscrowMatchesBooking} -- the caller checks
 * that first.
 */
export function deriveEscrowLifecycle(
  booking: BookingRow,
  row: EscrowSummary,
  recordedDecision: EscrowDisputeResolutionRow | undefined,
): LifecycleDerivation {
  const snapshot = row.snapshot as SingleReleaseEscrowSnapshot;
  const balance = humanDecimalToSmallestUnits(row.balance);
  if (balance === undefined) {
    return { kind: "mismatch", reason: `balance "${row.balance}" is not a valid decimal amount` };
  }

  if (snapshot.dispute?.resolved) {
    // Balance is not part of this condition: a resolved dispute is a
    // dispute-resolver decision the read-model records directly
    // (`dispute.resolved`), not something inferred from money having
    // already moved -- a third party overfunding the escrow after
    // resolution must never keep this stuck as "unresolved".
    if (!recordedDecision) return { kind: "unresolved-decision" };
    return { kind: "transition", action: "resolved", outcome: recordedDecision.outcome };
  }
  if (row.status === "released" || snapshot.released) {
    return { kind: "transition", action: "released" };
  }
  const depositAmount = BigInt(booking.depositAmount);
  // `disputed` and `approved` both presuppose the deposit is actually
  // funded -- without this, an unfunded escrow that is merely disputed or
  // approved (both possible against zero balance, at least on paper) would
  // reach `escrow_state = "locked"` and then `lockDeposit`/`fundDeposit`
  // would refuse forever, believing the deposit was already secured.
  if (balance >= depositAmount) {
    if (snapshot.dispute?.isDisputed) {
      return { kind: "transition", action: "disputed" };
    }
    if (!snapshot.released && isMilestoneApproved(snapshot.milestones?.[0])) {
      return { kind: "transition", action: "approved" };
    }
  }
  if (row.status === "active" && balance >= depositAmount) {
    return { kind: "transition", action: "funded" };
  }
  return { kind: "none" };
}

export type ProcessEscrowRowOutcome = "applied" | "duplicate" | "anomaly" | "none";

export interface ProcessEscrowRowDeps {
  /** Overridable only so a test can simulate a failure between the dedupe
   * insert and the escrow-state write; the real writer is always
   * {@link updateEscrowStateIfNotTerminalSync}. Returns whether the write
   * actually happened (see that function's own doc comment for why it can
   * decline one). */
  updateEscrowState?: (tx: DbOrTx, bookingId: string, escrowState: EscrowState) => boolean;
}

function defaultLog(message: string): void {
  console.error(message);
}

/**
 * Processes one escrow's current read-model row for one reconcilable
 * booking, at most once. Order of guards, each matching an I/O-matrix row:
 * (1) the booking is already terminal (by this call's own, possibly stale,
 * snapshot) -- a stale/out-of-order row can never regress it, so this
 * returns `"none"` before looking at the row at all (a fast-path only --
 * the escrow-state write below is *also* conditioned in SQL, which is what
 * actually prevents a regression when this snapshot turns out to be
 * stale); (2) the row's own `lastLedgerSeq` is at or below the stored
 * watermark -- already seen, restart-safe skip; (3) the row does not match
 * its booking, or a malformed field (a non-integer `lastLedgerSeq`, a
 * missing `snapshot.roles`, ...) cannot even be evaluated -- anomaly,
 * logged, no state change, and the batch continues rather than throwing;
 * (4) no transition derives -- `"none"`; (5) a transition derives --
 * applied via the same atomic dedupe-insert-plus-state-write transaction
 * `chain/event-worker.ts` established, keyed by `(contractId,
 * lifecycleAction)`.
 *
 * The watermark advances to the row's own `lastLedgerSeq` whenever the row
 * was looked at and produced a definite, non-anomalous outcome (applied,
 * duplicate, or no transition) -- "looked at and found nothing new" still
 * means this exact snapshot need not be re-derived next run. It does
 * *not* advance on an anomaly: a mismatch can be transient (most notably a
 * resolved dispute with no Pactly decision recorded yet), so the same
 * `lastLedgerSeq` must still be looked at again once that changes.
 */
export async function processEscrowRow(
  db: Db,
  booking: BookingRow,
  providerAddress: string,
  platformAddress: string,
  row: EscrowSummary,
  log: (message: string) => void = defaultLog,
  deps: ProcessEscrowRowDeps = {},
): Promise<ProcessEscrowRowOutcome> {
  const updateEscrowState = deps.updateEscrowState ?? updateEscrowStateIfNotTerminalSync;

  if (booking.escrowState && (TERMINAL_ESCROW_STATES as readonly string[]).includes(booking.escrowState)) {
    return "none";
  }

  let rowLedgerSeq: bigint;
  try {
    rowLedgerSeq = BigInt(row.lastLedgerSeq);
  } catch {
    log(`[escrow-reconciler] anomaly: escrow ${row.contractId} for booking ${booking.id} has a non-integer lastLedgerSeq "${row.lastLedgerSeq}"`);
    return "anomaly";
  }

  const watermark = await getEscrowWatermark(db, row.contractId);
  if (watermark !== undefined && rowLedgerSeq <= BigInt(watermark)) {
    return "none";
  }

  // Only the *evaluation* (matching the row against its booking, deriving a
  // transition) is guarded here -- a malformed row (a missing
  // `snapshot.roles`, say) must become an anomaly, not abort the batch. The
  // actual write below is deliberately outside this `try`: a real failure
  // there (the injected fault this function's own tests simulate, or a
  // genuine crash) must still propagate as a rejection, not be swallowed
  // into a misleading "anomaly" outcome that looks like nothing happened.
  let outcome: ProcessEscrowRowOutcome;
  let transition: { action: EscrowLifecycleAction; escrowState: EscrowState; amount: bigint } | undefined;
  try {
    const mismatch = checkEscrowMatchesBooking(booking, providerAddress, platformAddress, row);
    if (mismatch) {
      log(`[escrow-reconciler] anomaly: escrow ${row.contractId} does not match booking ${booking.id}: ${mismatch}`);
      outcome = "anomaly";
    } else {
      const recordedDecision = await getEscrowDisputeResolution(db, booking.id);
      const derivation = deriveEscrowLifecycle(booking, row, recordedDecision);
      if (derivation.kind === "mismatch") {
        log(`[escrow-reconciler] anomaly: escrow ${row.contractId} for booking ${booking.id}: ${derivation.reason}`);
        outcome = "anomaly";
      } else if (derivation.kind === "unresolved-decision") {
        log(
          `[escrow-reconciler] anomaly: escrow ${row.contractId} shows a resolved dispute for booking ${booking.id} ` +
            "but no Pactly decision is recorded",
        );
        outcome = "anomaly";
      } else if (derivation.kind === "none") {
        outcome = "none";
      } else {
        const escrowState = escrowStateForLifecycleAction(derivation.action, derivation.outcome);
        const amount = humanDecimalToSmallestUnits(row.balance) ?? 0n;
        if (derivation.action === "resolved" && amount !== 0n) {
          // Expected only when a third party funds the escrow further
          // after Pactly's own resolution -- not an anomaly (the
          // resolution itself is still trusted and applied), just worth a
          // log line rather than silently discarding the information.
          log(
            `[escrow-reconciler] note: escrow ${row.contractId} resolved for booking ${booking.id} with a non-zero ` +
              `balance ("${row.balance}") -- applying the recorded decision anyway`,
          );
        }
        transition = { action: derivation.action, escrowState, amount };
        outcome = "applied"; // provisional -- corrected below once the write itself runs
      }
    }
  } catch (error) {
    if (error instanceof EscrowConfigError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    log(`[escrow-reconciler] anomaly: escrow ${row.contractId} for booking ${booking.id} could not be evaluated: ${reason}`);
    outcome = "anomaly";
  }

  if (transition) {
    const toApply = transition;
    // Synchronous throughout, per better-sqlite3's transaction contract: an
    // `await` inside this callback would let the driver COMMIT before the
    // awaited write actually ran (mirrors `chain/event-worker.ts`'s
    // `processEvent`). Left outside the `try` above on purpose -- see this
    // function's own note by that block.
    const result = db.transaction((tx) => {
      const inserted = insertEscrowProcessedEventIfNewSync(tx, {
        bookingId: booking.id,
        contractId: row.contractId,
        lifecycleAction: toApply.action,
        amount: toApply.amount.toString(),
        ledgerSeq: row.lastLedgerSeq,
        isAnomaly: false,
        processedAt: Date.now(),
      });
      // The state write is conditioned in SQL on the booking not already
      // being terminal (see `updateEscrowStateIfNotTerminalSync`'s own doc
      // comment) -- the guard at the top of this function reads a snapshot
      // that can be stale within one batch (a second row for this same
      // contract, processed after an earlier row in the same batch already
      // moved this booking to a terminal state); this is what actually
      // prevents a regression, not that snapshot.
      const wrote = inserted && updateEscrowState(tx, booking.id, toApply.escrowState);
      return { inserted, wrote };
    });
    outcome = !result.inserted ? "duplicate" : result.wrote ? "applied" : "none";
  }

  if (outcome !== "anomaly") {
    // Not advanced on an anomaly: a mismatch can be transient (most
    // notably "resolved on chain, no Pactly decision recorded yet" --
    // `resolveBookingDispute` may simply not have run yet), and advancing
    // the watermark past it would mean this exact `lastLedgerSeq` is never
    // looked at again even once the decision *is* recorded.
    await setEscrowWatermark(db, row.contractId, row.lastLedgerSeq);
  }
  return outcome;
}

export interface EscrowReadDeps {
  apiUrl: string;
  apiKey: string;
  platformId: string;
  platformAddress: string;
  listEscrows: (params: ListEscrowsParams) => Promise<ListEscrowsResponse>;
}

function defaultReadDeps(overrides: Partial<EscrowReadDeps>): EscrowReadDeps {
  const apiUrl = overrides.apiUrl ?? config.trustlessWorkApiUrl;
  const apiKey = overrides.apiKey ?? config.trustlessWorkApiKey;
  const platformId = overrides.platformId ?? config.trustlessWorkPlatformId;
  const platformAddress = overrides.platformAddress ?? config.trustlessWorkPlatformAddress;

  let client: TrustlessWorkClient | undefined;
  const getClient = (): TrustlessWorkClient => {
    if (!apiUrl) {
      throw new EscrowConfigError(
        "TRUSTLESS_WORK_API_URL is empty. Configure the Trustless Work API base URL before starting the " +
          "escrow reconciler (see .env.example).",
      );
    }
    if (!apiKey) {
      throw new EscrowConfigError(
        "TRUSTLESS_WORK_API_KEY is empty. Configure the Trustless Work API key before starting the escrow " +
          "reconciler (see .env.example).",
      );
    }
    client ??= new TrustlessWorkClient({ baseURL: apiUrl, apiKey });
    return client;
  };

  return {
    apiUrl,
    apiKey,
    platformId,
    platformAddress,
    listEscrows: overrides.listEscrows ?? ((params) => getClient().rest.listEscrows(params)),
  };
}

/** The Trustless Work API's own practical ceiling on how many `contractIds`
 * one `listEscrows` call accepts is undocumented without a live key (Story
 * 1.8's own blocked findings); chunked defensively at a conservative size
 * so this reconciler degrades to more, smaller calls rather than one
 * arbitrarily large one. */
const LIST_ESCROWS_CHUNK_SIZE = 50;

/** Fetches every requested `contractId`'s current read-model row, in
 * `contractIds`-scoped chunks, following every keyset page each chunk
 * returns (AC4: "chunked, every keyset page followed") -- never just the
 * first page. Read errors are translated the same way a mutate call's are
 * (AC5: "This covers the reconciler's own read calls as much as the six
 * mutate calls"). */
export async function fetchOwnedEscrows(
  listEscrows: EscrowReadDeps["listEscrows"],
  contractIds: string[],
): Promise<EscrowSummary[]> {
  const rows: EscrowSummary[] = [];
  for (let start = 0; start < contractIds.length; start += LIST_ESCROWS_CHUNK_SIZE) {
    const chunk = contractIds.slice(start, start + LIST_ESCROWS_CHUNK_SIZE);
    let cursor: string | undefined;
    for (;;) {
      const page = await callTrustlessWork(() => listEscrows({ contractIds: chunk, cursor, limit: 100 }));
      rows.push(...page.data);
      if (!page.hasMore || !page.nextCursor) break;
      if (page.nextCursor === cursor) {
        // A page claiming more data exists, at the exact same cursor it
        // was just asked with, never actually advances -- following it
        // would loop forever rather than reaching the "no bug" fallthrough
        // the pagination contract otherwise guarantees.
        throw new EscrowRequestError(
          `Trustless Work's listEscrows returned hasMore: true with a nextCursor ("${page.nextCursor ?? ""}") ` +
            "that does not advance past the cursor just sent",
        );
      }
      cursor = page.nextCursor;
    }
  }
  return rows;
}

export interface ReconcilerDeps {
  db: Db;
  listEscrows: (params: ListEscrowsParams) => Promise<ListEscrowsResponse>;
  /** Pactly's own Stellar account -- defaults to `config
   * .trustlessWorkPlatformAddress`. Passed through to
   * `checkEscrowMatchesBooking` for every row this run processes; empty
   * refuses the whole run with a typed `EscrowConfigError` rather than
   * silently skipping the platform/disputeResolvers/admin role checks. */
  platformAddress?: string;
  log?: (message: string) => void;
}

export interface RunReconcilerResult {
  applied: number;
  duplicates: number;
  anomalies: number;
  /** No transition derived, or the row was already covered by its
   * escrow's stored watermark, or the booking was already terminal --
   * every "looked at this row and nothing changed" outcome. */
  skipped: number;
}

/**
 * Runs exactly one fetch-and-apply batch: every currently reconcilable
 * booking's persisted `contractId`, resolved fresh from the database on
 * every call (there is no cross-run "cursor" to resume in the way
 * `chain/event-worker.ts`'s global event stream needed one -- the *set of
 * escrows to look at* is itself derived from `bookings` each run; only the
 * per-escrow `lastLedgerSeq` watermark persists across runs). A
 * long-running process calls this in a loop (not this story's job,
 * mirroring `chain/event-worker.ts`'s own note); a test calls it directly,
 * once or several times, against a real temporary database.
 */
export async function runReconcilerOnce(deps: ReconcilerDeps): Promise<RunReconcilerResult> {
  const { db, listEscrows, log = defaultLog, platformAddress = config.trustlessWorkPlatformAddress } = deps;

  const candidates = await getReconcilableBookings(db);
  let applied = 0;
  let duplicates = 0;
  let anomalies = 0;
  let skipped = 0;
  if (candidates.length === 0) {
    return { applied, duplicates, anomalies, skipped };
  }

  const byContractId = new Map<string, ReconcilableBooking>(candidates.map((candidate) => [candidate.booking.escrowContractId as string, candidate]));
  const contractIds = [...byContractId.keys()];

  const rows = await fetchOwnedEscrows(listEscrows, contractIds);

  for (const row of rows) {
    const candidate = byContractId.get(row.contractId);
    if (!candidate) {
      // A row Pactly did not ask for -- the SDK should never return one
      // outside the requested `contractIds`, but this is treated as an
      // anomaly rather than trusted, per this story's own "row for an
      // unrequested contract" I/O-matrix row. No row is invented for it:
      // there is no booking to attribute it to.
      log(`[escrow-reconciler] anomaly: received escrow ${row.contractId}, which was not among the requested contractIds`);
      anomalies += 1;
      continue;
    }
    const outcome = await processEscrowRow(db, candidate.booking, candidate.providerAddress, platformAddress, row, log);
    if (outcome === "applied") applied += 1;
    else if (outcome === "duplicate") duplicates += 1;
    else if (outcome === "anomaly") anomalies += 1;
    else skipped += 1;
  }

  return { applied, duplicates, anomalies, skipped };
}

/** The real seam, wired to `config` -- what a real long-running process
 * wires `runReconcilerOnce` to. Never constructed by a test. */
export function realListEscrows(overrides: Partial<EscrowReadDeps> = {}): EscrowReadDeps["listEscrows"] {
  return defaultReadDeps(overrides).listEscrows;
}

export interface EscrowLifecycle {
  contractId?: string;
  action?: EscrowLifecycleAction;
  /** Present only when `action` is `"resolved"`. */
  outcome?: DisputeOutcome;
}

/**
 * The read helper Epic 3's UI needs (Design Notes: "Why lifecycle rows are
 * finer than escrow_state"; EXPERIENCE.md's "Ready to release" / "In
 * resolution" / "Resolved" labels): the persisted `contractId`, the latest
 * lifecycle action this reconciler has recorded for the booking, and --
 * only once that action is `"resolved"` -- the recorded outcome. `"latest"`
 * is the furthest action along the lifecycle (`RECOGNIZED_LIFECYCLE_ACTIONS`
 * order), not the greatest `processedAt`: one poll can record two actions
 * in the same millisecond. When both `approved` and `disputed` exist,
 * `disputed` wins, which is also what the UX needs ("In resolution" over
 * "Ready to release"). Rows for an older, superseded `contractId` are
 * ignored. `undefined` only for
 * a booking id that does not exist at all; a real booking with no
 * `contractId` and no recorded lifecycle rows yet returns `{}` with both
 * fields `undefined`, not `undefined` itself.
 */
/** Ranks `RECOGNIZED_LIFECYCLE_ACTIONS` order and picks the row furthest
 * along it -- not the greatest `processedAt` (two actions derived in the
 * same poll land in the same millisecond, so a timestamp cannot order
 * them). Shared by the single-booking and batched lifecycle reads below, so
 * they can never derive a different "latest" for the same rows. */
function pickLatestLifecycleEvent<T extends { lifecycleAction: string }>(rows: readonly T[]): T {
  const rank = (action: string): number => (RECOGNIZED_LIFECYCLE_ACTIONS as readonly string[]).indexOf(action);
  return rows.reduce((newest, candidate) => (rank(candidate.lifecycleAction) > rank(newest.lifecycleAction) ? candidate : newest));
}

/** Turns one booking's already-filtered processed-event rows (matching its
 * *current* `escrowContractId` only) plus its recorded dispute decision, if
 * any, into an {@link EscrowLifecycle} -- the one place both
 * {@link getEscrowLifecycle} and {@link getEscrowLifecycleForBookings} build
 * this shape, so a list and a single read can never drift apart. */
function buildLifecycle(
  booking: BookingRow,
  matchingRows: readonly EscrowProcessedEventRow[],
  decision: EscrowDisputeResolutionRow | undefined,
): EscrowLifecycle {
  if (matchingRows.length === 0) {
    return { contractId: booking.escrowContractId ?? undefined };
  }
  const latest = pickLatestLifecycleEvent(matchingRows);
  const action = latest.lifecycleAction as EscrowLifecycleAction;
  const result: EscrowLifecycle = { contractId: booking.escrowContractId ?? undefined, action };
  if (action === "resolved" && decision) {
    result.outcome = decision.outcome;
  }
  return result;
}

export async function getEscrowLifecycle(db: Db, bookingId: string): Promise<EscrowLifecycle | undefined> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) return undefined;

  const rows = (await listEscrowProcessedEventsForBooking(db, bookingId)).filter(
    (row) => row.contractId === booking.escrowContractId,
  );
  const lifecycle = buildLifecycle(booking, rows, undefined);
  // The dispute-resolution decision is only ever fetched once a "resolved"
  // action is actually on record -- every other booking (the overwhelming
  // majority) skips this second query entirely.
  if (lifecycle.action === "resolved") {
    const decision = await getEscrowDisputeResolution(db, bookingId);
    if (decision) lifecycle.outcome = decision.outcome;
  }
  return lifecycle;
}

/**
 * Story 3.5: the same lifecycle {@link getEscrowLifecycle} derives, batched
 * for a whole list of bookings -- one query against
 * `escrow_processed_events` and one against `escrow_dispute_resolutions`
 * for every booking id at once (the spec's own Code Map note: "avoid N+1 by
 * reading escrow_processed_events and escrow_dispute_resolutions for all
 * listed booking ids in one query each"), never one round trip per row.
 * `undefined` is never a value in the returned map -- a booking with no
 * recorded transition yet still gets `{contractId}` (or `{}` when it has no
 * `contractId` either), exactly like the single-booking read.
 */
export async function getEscrowLifecycleForBookings(db: Db, bookings: readonly BookingRow[]): Promise<Map<string, EscrowLifecycle>> {
  const result = new Map<string, EscrowLifecycle>();
  if (bookings.length === 0) return result;

  const bookingIds = bookings.map((booking) => booking.id);
  const [allEvents, decisionsByBooking] = await Promise.all([
    listEscrowProcessedEventsForBookings(db, bookingIds),
    getEscrowDisputeResolutionsForBookings(db, bookingIds),
  ]);
  const eventsByBooking = new Map<string, EscrowProcessedEventRow[]>();
  for (const row of allEvents) {
    const existing = eventsByBooking.get(row.bookingId);
    if (existing) {
      existing.push(row);
    } else {
      eventsByBooking.set(row.bookingId, [row]);
    }
  }
  for (const booking of bookings) {
    const rows = (eventsByBooking.get(booking.id) ?? []).filter((row) => row.contractId === booking.escrowContractId);
    result.set(booking.id, buildLifecycle(booking, rows, decisionsByBooking.get(booking.id)));
  }
  return result;
}
