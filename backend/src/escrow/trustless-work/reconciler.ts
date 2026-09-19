/**
 * The Trustless Work reconciler (AD-9), amended 2026-09-19 -- Story 2.6's
 * retarget of `chain/event-worker.ts` onto Trustless Work's escrow
 * read-model instead of Soroban `getEvents`. The only writer of
 * `bookings.escrow_state` for any Trustless-Work-backed booking (AD-1/AD-3);
 * every other module that touches a booking row leaves that column alone.
 *
 * **Why this does not poll `EscrowEvent.kind` (the pre-amendment design).**
 * The installed `@trustless-work/escrow-js@1.0.0-beta.1`'s own types
 * confirm `EscrowEvent.kind` is a bare `string` -- the SDK defines no fixed
 * event vocabulary. A reconciler that branched on invented names
 * (`"funded"`, `"approved"`, ...) would silently drop every *real* event
 * whose actual name differs (this story's own review, finding I1/G-A).
 * Instead this reconciler derives a lifecycle transition from an
 * `EscrowSummary` read-model row's own typed fields -- `status`, `balance`,
 * `snapshot.dispute`, `snapshot.released`, milestone `approvals` -- which
 * the SDK does define, per the Design Notes' lifecycle derivation table.
 *
 * **Why this does not discover escrows by `engagementId` (also
 * pre-amendment).** `engagementId` is a field anyone deploying an escrow
 * can set to any value, including another booking's id (review finding
 * B2/G-B). This reconciler instead polls only the `contractId`s Pactly
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
import { EscrowConfigError } from "./errors.js";
import { config } from "../../config.js";
import { getBookingById, getReconcilableBookings, updateEscrowStateSync, type ReconcilableBooking } from "../../db/bookings.js";
import { insertEscrowProcessedEventIfNewSync, listEscrowProcessedEventsForBooking } from "../../db/escrowProcessedEvents.js";
import { getEscrowWatermark, setEscrowWatermark } from "../../db/escrowReconcilerWatermarks.js";
import { getEscrowDisputeResolution, type EscrowDisputeResolutionRow } from "../../db/escrowDisputeResolutions.js";
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

/** `escrow_state`s a booking must never leave once reached (AC4). */
const TERMINAL_ESCROW_STATES: ReadonlySet<EscrowState> = new Set(["released", "refunded"]);

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

/**
 * Cross-checks a read-model row against the booking its persisted
 * `contractId` names, per the Design Notes' lifecycle derivation table:
 * `engagementId` = booking id, `snapshot.roles.approvers` = `[client]`,
 * `receiver` = provider wallet, `snapshot.amount` = deposit,
 * `snapshot.trustline.contractId` = token when present. Returns a reason
 * string on any mismatch, `undefined` when the row may be trusted.
 */
export function checkEscrowMatchesBooking(booking: BookingRow, providerAddress: string, row: EscrowSummary): string | undefined {
  if (row.type !== "single-release") {
    return `escrow type "${row.type}" is not single-release`;
  }
  if (row.engagementId !== booking.id) {
    return `engagementId "${row.engagementId}" does not match booking id "${booking.id}"`;
  }
  const snapshot = row.snapshot as SingleReleaseEscrowSnapshot;
  const approvers = snapshot.roles.approvers;
  if (!(approvers.length === 1 && approvers[0] === booking.clientWalletAddress)) {
    return `approvers ${JSON.stringify(approvers)} do not match the booking's client wallet "${booking.clientWalletAddress}"`;
  }
  if (snapshot.roles.receiver !== providerAddress) {
    return `receiver "${snapshot.roles.receiver}" does not match the booking's provider wallet "${providerAddress}"`;
  }
  const snapshotAmount = humanDecimalToSmallestUnits(snapshot.amount);
  if (snapshotAmount === undefined || snapshotAmount.toString() !== booking.depositAmount) {
    return `escrow amount "${snapshot.amount}" does not match the booking's deposit amount "${booking.depositAmount}"`;
  }
  const trustlineContractId = snapshot.trustline?.contractId;
  if (trustlineContractId && trustlineContractId !== booking.tokenAddress) {
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
 * The lifecycle derivation table itself (Design Notes, amended
 * 2026-09-19), evaluated in order for one already-matched row: (1) a
 * resolved dispute with a zero balance, mapped through Pactly's own
 * recorded decision; (2) released; (3) an open dispute; (3b) milestone 0's
 * approvals reached (not yet released); (4) funded. Anything else derives
 * no transition. Never called on a row that failed
 * {@link checkEscrowMatchesBooking} -- the caller checks that first.
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

  if (snapshot.dispute?.resolved && balance === 0n) {
    if (!recordedDecision) return { kind: "unresolved-decision" };
    return { kind: "transition", action: "resolved", outcome: recordedDecision.outcome };
  }
  if (row.status === "released" || snapshot.released) {
    return { kind: "transition", action: "released" };
  }
  if (snapshot.dispute?.isDisputed) {
    return { kind: "transition", action: "disputed" };
  }
  if (!snapshot.released && isMilestoneApproved(snapshot.milestones?.[0])) {
    return { kind: "transition", action: "approved" };
  }
  const depositAmount = BigInt(booking.depositAmount);
  if (row.status === "active" && balance >= depositAmount) {
    return { kind: "transition", action: "funded" };
  }
  return { kind: "none" };
}

export type ProcessEscrowRowOutcome = "applied" | "duplicate" | "anomaly" | "none";

export interface ProcessEscrowRowDeps {
  /** Overridable only so a test can simulate a failure between the dedupe
   * insert and the escrow-state write; the real writer is always
   * {@link updateEscrowStateSync}. */
  updateEscrowState?: (tx: DbOrTx, bookingId: string, escrowState: EscrowState) => void;
}

function defaultLog(message: string): void {
  console.error(message);
}

/**
 * Processes one escrow's current read-model row for one reconcilable
 * booking, at most once. Order of guards, each matching an I/O-matrix row:
 * (1) the booking is already terminal -- a stale/out-of-order row can never
 * regress it, so this returns `"none"` before looking at the row at all;
 * (2) the row's own `lastLedgerSeq` is at or below the stored watermark --
 * already seen, restart-safe skip; (3) the row does not match its booking
 * -- anomaly, logged, no state change; (4) no transition derives -- `"none"`;
 * (5) a transition derives -- applied exactly once via the same atomic
 * dedupe-insert-plus-state-write transaction `chain/event-worker.ts`
 * established, keyed by `(contractId, lifecycleAction)`.
 *
 * The watermark advances to the row's own `lastLedgerSeq` whenever the row
 * was actually looked at (every case except the watermark-skip itself),
 * regardless of outcome -- "looked at and found nothing new" still means
 * this exact snapshot need not be re-derived next run.
 */
export async function processEscrowRow(
  db: Db,
  booking: BookingRow,
  providerAddress: string,
  row: EscrowSummary,
  log: (message: string) => void = defaultLog,
  deps: ProcessEscrowRowDeps = {},
): Promise<ProcessEscrowRowOutcome> {
  const updateEscrowState = deps.updateEscrowState ?? updateEscrowStateSync;

  if (booking.escrowState && TERMINAL_ESCROW_STATES.has(booking.escrowState)) {
    // Per AC4, `getReconcilableBookings` already excludes a terminal
    // booking from the next run's query -- this guard exists so the same
    // rule holds for a row processed directly (unit tests) or one seen
    // mid-batch before this booking's own terminal write has had a chance
    // to exclude it from a *later* run.
    return "none";
  }

  const watermark = await getEscrowWatermark(db, row.contractId);
  const rowLedgerSeq = BigInt(row.lastLedgerSeq);
  if (watermark !== undefined && rowLedgerSeq <= BigInt(watermark)) {
    return "none";
  }

  const mismatch = checkEscrowMatchesBooking(booking, providerAddress, row);
  let outcome: ProcessEscrowRowOutcome;
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
      // Synchronous throughout, per better-sqlite3's transaction contract:
      // an `await` inside this callback would let the driver COMMIT before
      // the awaited write actually ran (mirrors
      // `chain/event-worker.ts`'s `processEvent`).
      const isNew = db.transaction((tx) => {
        const inserted = insertEscrowProcessedEventIfNewSync(tx, {
          bookingId: booking.id,
          contractId: row.contractId,
          lifecycleAction: derivation.action,
          amount: amount.toString(),
          ledgerSeq: row.lastLedgerSeq,
          isAnomaly: false,
          processedAt: Date.now(),
        });
        if (inserted) {
          updateEscrowState(tx, booking.id, escrowState);
        }
        return inserted;
      });
      outcome = isNew ? "applied" : "duplicate";
    }
  }

  await setEscrowWatermark(db, row.contractId, row.lastLedgerSeq);
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
      cursor = page.nextCursor;
    }
  }
  return rows;
}

export interface ReconcilerDeps {
  db: Db;
  listEscrows: (params: ListEscrowsParams) => Promise<ListEscrowsResponse>;
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
  const { db, listEscrows, log = defaultLog } = deps;

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
    const outcome = await processEscrowRow(db, candidate.booking, candidate.providerAddress, row, log);
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
export async function getEscrowLifecycle(db: Db, bookingId: string): Promise<EscrowLifecycle | undefined> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) return undefined;

  const rows = (await listEscrowProcessedEventsForBooking(db, bookingId)).filter(
    (row) => row.contractId === booking.escrowContractId,
  );
  if (rows.length === 0) {
    return { contractId: booking.escrowContractId ?? undefined };
  }
  // Ranked by lifecycle position, not `processedAt`: two actions derived in
  // the same poll land in the same millisecond, so a timestamp cannot order
  // them. RECOGNIZED_LIFECYCLE_ACTIONS is already in lifecycle order.
  const rank = (action: string): number => (RECOGNIZED_LIFECYCLE_ACTIONS as readonly string[]).indexOf(action);
  const latest = rows.reduce((newest, candidate) =>
    rank(candidate.lifecycleAction) > rank(newest.lifecycleAction) ? candidate : newest,
  );
  const action = latest.lifecycleAction as EscrowLifecycleAction;
  const result: EscrowLifecycle = { contractId: booking.escrowContractId ?? undefined, action };
  if (action === "resolved") {
    const decision = await getEscrowDisputeResolution(db, bookingId);
    if (decision) result.outcome = decision.outcome;
  }
  return result;
}
