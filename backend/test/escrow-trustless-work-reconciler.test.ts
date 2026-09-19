/**
 * The Trustless Work reconciler driven as a unit, over a real temporary
 * SQLite database (`openDatabase(":memory:")`) through its injected
 * `listEscrows` seam -- never against the network. Covers the I/O matrix
 * rows this story's amended spec names for the reconciler: every lifecycle
 * derivation (funded/approved/disputed/released/resolved, each requiring an
 * actually-funded balance except resolved itself), same row replayed,
 * restart resumes from the stored per-escrow watermark (never advanced on
 * an anomaly), an escrow that does not match its booking on any of its
 * role/amount/trustline fields (anomaly, no state change), a row for an
 * unrequested contract (ignored), a stale/out-of-order row after a terminal
 * state (no regression, enforced in SQL even against a stale in-memory
 * snapshot), malformed rows that must not abort the batch, and
 * `getEscrowLifecycle`'s own read shape -- each at the *batch* level
 * (`runReconcilerOnce`) as well as the single-row level.
 */
import "./testConfigEnv.js";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  TrustlessWorkNetworkError,
  type EscrowSummary,
  type ListEscrowsResponse,
  type SingleReleaseEscrowSnapshot,
} from "@trustless-work/escrow-js";

import { EscrowConfigError, EscrowRequestError } from "../src/escrow/trustless-work/errors.js";

import {
  checkEscrowMatchesBooking,
  deriveEscrowLifecycle,
  escrowStateForLifecycleAction,
  fetchOwnedEscrows,
  getEscrowLifecycle,
  humanDecimalToSmallestUnits,
  processEscrowRow,
  realListEscrows,
  runReconcilerOnce,
  type ReconcilerDeps,
} from "../src/escrow/trustless-work/reconciler.js";
import { getBookingById, updateEscrowContractId, type BookingRow } from "../src/db/bookings.js";
import { recordEscrowDisputeResolution } from "../src/db/escrowDisputeResolutions.js";
import { getEscrowWatermark, setEscrowWatermark } from "../src/db/escrowReconcilerWatermarks.js";
import { getEscrowProcessedEvent } from "../src/db/escrowProcessedEvents.js";
import { closeDatabase, openTestDatabase, randomBookingId, seedBooking, seedProviderProfile } from "./helpers.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function fakeAddress(): string {
  return Keypair.random().publicKey();
}

const DEPOSIT_AMOUNT = "10000000"; // 1.0 USDC at 7 decimals

/** Pactly's own platform account, shared by every seeded booking in this
 * file -- one real Pactly platform identity, not one per test. */
const PLATFORM_ADDRESS = fakeAddress();

interface SeededBooking {
  bookingId: string;
  clientAddress: string;
  providerAddress: string;
  tokenAddress: string;
  contractId: string;
}

/** Seeds a booking with a persisted `contractId` -- the state every
 * reconciler row this file exercises assumes (`lockDeposit` already ran). */
async function seedReconcilableBooking(result: Awaited<ReturnType<typeof openTestDatabase>>): Promise<SeededBooking> {
  const clientAddress = fakeAddress();
  const providerAddress = fakeAddress();
  const tokenAddress = fakeContractId();
  const providerProfileId = await seedProviderProfile(result, { walletAddress: providerAddress });
  const bookingId = await seedBooking(result, {
    providerProfileId,
    clientWalletAddress: clientAddress,
    tokenAddress,
    depositAmount: DEPOSIT_AMOUNT,
  });
  const contractId = fakeContractId();
  await updateEscrowContractId(result.db, bookingId, contractId);
  return { bookingId, clientAddress, providerAddress, tokenAddress, contractId };
}

function baseSnapshot(overrides: Partial<SingleReleaseEscrowSnapshot> = {}, seed: SeededBooking): SingleReleaseEscrowSnapshot {
  return {
    title: "Pactly booking",
    description: "Pactly session deposit",
    engagementId: seed.bookingId,
    trustline: { address: seed.tokenAddress, contractId: seed.tokenAddress, symbol: "USDC" },
    platformFee: "0",
    roles: {
      approvers: [seed.clientAddress],
      serviceProviders: [seed.providerAddress],
      releaseSigners: [seed.providerAddress],
      receiver: seed.providerAddress,
      platform: PLATFORM_ADDRESS,
      disputeResolvers: [PLATFORM_ADDRESS],
      admin: PLATFORM_ADDRESS,
    },
    amount: "1", // 10_000_000 smallest units / 1e7
    milestones: [{ description: "session", approvalsTarget: 1 }],
    ...overrides,
  };
}

function fakeEscrowRow(seed: SeededBooking, overrides: Partial<EscrowSummary> = {}, snapshotOverrides: Partial<SingleReleaseEscrowSnapshot> = {}): EscrowSummary {
  return {
    network: "testnet",
    contractId: seed.contractId,
    type: "single-release",
    engagementId: seed.bookingId,
    status: "active",
    totalAmount: null,
    balance: "0",
    asset: { name: "USDC", address: seed.tokenAddress, contractId: seed.tokenAddress },
    lastLedgerSeq: "100",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    snapshot: baseSnapshot(snapshotOverrides, seed),
    ...overrides,
  };
}

function listEscrowsReturning(rows: EscrowSummary[]): ReconcilerDeps["listEscrows"] {
  return async () => ({ data: rows, hasMore: false, nextCursor: null }) satisfies ListEscrowsResponse;
}

async function getBooking(db: Parameters<typeof getBookingById>[0], bookingId: string): Promise<BookingRow | undefined> {
  return getBookingById(db, bookingId);
}

/** Every `runReconcilerOnce` call in this file shares one Pactly platform
 * address -- this wraps it so call sites read like the two-argument
 * version they were before that became a real check. */
function runOnce(db: Parameters<typeof runReconcilerOnce>[0]["db"], deps: Omit<ReconcilerDeps, "db" | "platformAddress">) {
  return runReconcilerOnce({ db, platformAddress: PLATFORM_ADDRESS, ...deps });
}

test("a funded row (active, balance >= deposit) sets escrow_state to locked and records a 'funded' row", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "active", balance: "1" });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "applied");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "locked");
    const processed = await getEscrowProcessedEvent(result.db, seed.contractId, "funded");
    assert.ok(processed);
  } finally {
    closeDatabase(result);
  }
});

test("a partially funded row (balance < deposit) derives no transition", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "active", balance: "0.5" });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "none");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, null);
  } finally {
    closeDatabase(result);
  }
});

test("an approved row (milestone 0 approvals reached target, not released) stays locked and is recorded distinctly from funded", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const fundedRow = fakeEscrowRow(seed, { status: "active", balance: "1", lastLedgerSeq: "100" });
    await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, fundedRow);

    const approvedRow = fakeEscrowRow(
      seed,
      { status: "active", balance: "1", lastLedgerSeq: "200" },
      { milestones: [{ description: "session", approvalsTarget: 1, approvals: { target: 1, approvalCount: 1, approvedBy: [seed.clientAddress] } }] },
    );
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, approvedRow);
    assert.equal(outcome, "applied");

    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "locked", 'UX "Ready to release" -- never looks released before release actually happens');

    assert.ok(await getEscrowProcessedEvent(result.db, seed.contractId, "funded"));
    assert.ok(await getEscrowProcessedEvent(result.db, seed.contractId, "approved"));
  } finally {
    closeDatabase(result);
  }
});

test("Story 3.6: a completed row (milestone 0 status 'completed', not yet approved) stays locked and ranks between funded and approved", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const fundedRow = fakeEscrowRow(seed, { status: "active", balance: "1", lastLedgerSeq: "100" });
    await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, fundedRow);

    const completedRow = fakeEscrowRow(
      seed,
      { status: "active", balance: "1", lastLedgerSeq: "200" },
      { milestones: [{ description: "session", approvalsTarget: 1, status: "completed" }] },
    );
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, completedRow);
    assert.equal(outcome, "applied");

    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "locked", "completing the appointment moves no money");

    assert.ok(await getEscrowProcessedEvent(result.db, seed.contractId, "funded"));
    assert.ok(await getEscrowProcessedEvent(result.db, seed.contractId, "completed"));

    const lifecycle = await getEscrowLifecycle(result.db, seed.bookingId);
    assert.equal(lifecycle?.action, "completed", "the latest action ranks 'completed' above 'funded'");
  } finally {
    closeDatabase(result);
  }
});

test("Story 3.6: once approved, a later poll of the same escrow never regresses the lifecycle label back to 'completed'", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const completedRow = fakeEscrowRow(
      seed,
      { status: "active", balance: "1", lastLedgerSeq: "100" },
      { milestones: [{ description: "session", approvalsTarget: 1, status: "completed" }] },
    );
    await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, completedRow);

    const approvedRow = fakeEscrowRow(
      seed,
      { status: "active", balance: "1", lastLedgerSeq: "200" },
      { milestones: [{ description: "session", approvalsTarget: 1, approvals: { target: 1, approvalCount: 1, approvedBy: [seed.clientAddress] } }] },
    );
    await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, approvedRow);

    const lifecycle = await getEscrowLifecycle(result.db, seed.bookingId);
    assert.equal(lifecycle?.action, "approved", "the rank of RECOGNIZED_LIFECYCLE_ACTIONS puts 'approved' above 'completed'");
  } finally {
    closeDatabase(result);
  }
});

test("a completed row against a zero balance derives no transition -- completed never implies funded", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(
      seed,
      { status: "active", balance: "0" },
      { milestones: [{ description: "session", approvalsTarget: 1, status: "completed" }] },
    );
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "none");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, null);
  } finally {
    closeDatabase(result);
  }
});

test("an approved row against a zero balance derives no transition -- approved never implies funded", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(
      seed,
      { status: "active", balance: "0" },
      { milestones: [{ description: "session", approvalsTarget: 1, approvals: { target: 1, approvalCount: 1, approvedBy: [seed.clientAddress] } }] },
    );
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "none");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, null);
  } finally {
    closeDatabase(result);
  }
});

test("a disputed row against a zero balance derives no transition -- disputed never implies funded", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "disputed", balance: "0" }, { dispute: { isDisputed: true, reason: "no-show", resolved: false } });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "none");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, null);
  } finally {
    closeDatabase(result);
  }
});

test("a released row (status: released) sets escrow_state to released", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "released", balance: "0" });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "applied");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "released");
  } finally {
    closeDatabase(result);
  }
});

test("a released row via snapshot.released (status still active) also sets escrow_state to released", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "active", balance: "0" }, { released: true });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "applied");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "released");
  } finally {
    closeDatabase(result);
  }
});

test("an open dispute leaves escrow_state locked -- opening a dispute never moves money automatically", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "disputed", balance: "1" }, { dispute: { isDisputed: true, reason: "no-show", resolved: false } });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "applied");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "locked");
  } finally {
    closeDatabase(result);
  }
});

test("a resolved dispute (balance zero, recorded decision refund-client) sets escrow_state to refunded", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    await recordEscrowDisputeResolution(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      outcome: "refund-client",
      txHash: "resolve-tx-hash",
      decidedAt: Date.now(),
    });
    const row = fakeEscrowRow(seed, { status: "disputed", balance: "0" }, { dispute: { isDisputed: true, reason: "no-show", resolved: true } });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "applied");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "refunded");
    assert.ok(await getEscrowProcessedEvent(result.db, seed.contractId, "resolved"));
  } finally {
    closeDatabase(result);
  }
});

test("a resolved dispute (recorded decision pay-provider) sets escrow_state to released", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    await recordEscrowDisputeResolution(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      outcome: "pay-provider",
      txHash: "resolve-tx-hash",
      decidedAt: Date.now(),
    });
    const row = fakeEscrowRow(seed, { status: "disputed", balance: "0" }, { dispute: { isDisputed: true, reason: "no-show", resolved: true } });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "applied");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "released");
  } finally {
    closeDatabase(result);
  }
});

test("a resolved dispute with a non-zero balance (overfunded by a third party) still applies the recorded decision, logged rather than stuck", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    await recordEscrowDisputeResolution(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      outcome: "refund-client",
      txHash: "resolve-tx-hash",
      decidedAt: Date.now(),
    });
    const row = fakeEscrowRow(seed, { status: "disputed", balance: "0.5" }, { dispute: { isDisputed: true, reason: "no-show", resolved: true } });
    const messages: string[] = [];
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row, (m) =>
      messages.push(m),
    );
    assert.equal(outcome, "applied");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "refunded");
    assert.ok(messages.some((m) => m.includes("non-zero")), "a non-zero balance on a resolved dispute is logged, not silently ignored");
    assert.ok(!messages.some((m) => m.includes("anomaly")), "this is not an anomaly -- the decision is still applied");
  } finally {
    closeDatabase(result);
  }
});

test("a resolved dispute with no recorded Pactly decision is an anomaly, no state change, and the watermark does not advance", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "disputed", balance: "0", lastLedgerSeq: "100" }, { dispute: { isDisputed: true, reason: "no-show", resolved: true } });
    const messages: string[] = [];
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row, (m) =>
      messages.push(m),
    );
    assert.equal(outcome, "anomaly");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, null);
    assert.ok(messages.some((m) => m.includes("anomaly")));
    assert.equal(await getEscrowWatermark(result.db, seed.contractId), undefined, "an anomaly must never advance the watermark");
  } finally {
    closeDatabase(result);
  }
});

test("once the decision is recorded, the exact same (previously anomalous) row at the same ledgerSeq is re-derived and applied", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "disputed", balance: "0", lastLedgerSeq: "100" }, { dispute: { isDisputed: true, reason: "no-show", resolved: true } });

    const first = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(first, "anomaly");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, null);

    await recordEscrowDisputeResolution(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      outcome: "refund-client",
      txHash: "resolve-tx-hash",
      decidedAt: Date.now(),
    });

    // Same row, same lastLedgerSeq as the first (anomalous) attempt -- only
    // reachable because the watermark was never advanced past it.
    const second = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(second, "applied");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "refunded");
  } finally {
    closeDatabase(result);
  }
});

test("replaying the same (contractId, lifecycleAction) changes nothing and inserts no duplicate row", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "active", balance: "1", lastLedgerSeq: "100" });
    const first = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(first, "applied");

    // Force a re-derivation of the *same* action by resetting the
    // watermark -- a real restart scenario, not merely calling the
    // function twice with an unchanged ledgerSeq (which the watermark
    // guard alone would already skip).
    await setEscrowWatermark(result.db, seed.contractId, "50");
    const second = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(second, "duplicate");

    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, "locked");
  } finally {
    closeDatabase(result);
  }
});

test("a row at or below the stored watermark is skipped without re-deriving anything", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    await setEscrowWatermark(result.db, seed.contractId, "100");
    const row = fakeEscrowRow(seed, { status: "active", balance: "1", lastLedgerSeq: "100" });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "none");
    const booking = await getBooking(result.db, seed.bookingId);
    assert.equal(booking?.escrowState, null, "a watermark-covered row must never be re-derived");
  } finally {
    closeDatabase(result);
  }
});

test("a stale/out-of-order row after a terminal escrow_state never regresses it", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const releasedRow = fakeEscrowRow(seed, { status: "released", balance: "0", lastLedgerSeq: "200" });
    await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, releasedRow);
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "released");

    // A stale/out-of-order row claiming "active" again, at a higher
    // ledgerSeq than the released row (so the watermark alone would not
    // have skipped it) -- the terminal-state guard must still hold.
    const staleRow = fakeEscrowRow(seed, { status: "active", balance: "1", lastLedgerSeq: "300" });
    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, staleRow);
    assert.equal(outcome, "none");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "released", "terminal states must never regress");
  } finally {
    closeDatabase(result);
  }
});

test("two rows for the same contract in one batch, terminal first, never regress the booking even against a stale in-memory snapshot", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    // The booking snapshot `runReconcilerOnce` would fetch once per batch,
    // deliberately reused (stale: `escrowState` still `null` here) for a
    // second row -- the SQL-conditioned write, not this in-memory guard,
    // is what must prevent the regression.
    const staleBookingSnapshot = (await getBooking(result.db, seed.bookingId))!;

    const releasedRow = fakeEscrowRow(seed, { status: "released", balance: "0", lastLedgerSeq: "100" });
    const first = await processEscrowRow(result.db, staleBookingSnapshot, seed.providerAddress, PLATFORM_ADDRESS, releasedRow);
    assert.equal(first, "applied");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "released");

    const disputedRow = fakeEscrowRow(
      seed,
      { status: "disputed", balance: "1", lastLedgerSeq: "200" },
      { dispute: { isDisputed: true, reason: "x", resolved: false } },
    );
    const second = await processEscrowRow(result.db, staleBookingSnapshot, seed.providerAddress, PLATFORM_ADDRESS, disputedRow);
    assert.equal(second, "none", "the conditioned write declines even though the stale snapshot's own guard would have let it through");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "released", "must never regress from released back to locked");
  } finally {
    closeDatabase(result);
  }
});

test("a non-integer lastLedgerSeq is an anomaly and does not abort the batch -- a following valid row still applies", async () => {
  const result = openTestDatabase();
  try {
    const badSeed = await seedReconcilableBooking(result);
    const goodSeed = await seedReconcilableBooking(result);
    const badRow = fakeEscrowRow(badSeed, { status: "active", balance: "1", lastLedgerSeq: "not-a-number" });
    const goodRow = fakeEscrowRow(goodSeed, { status: "active", balance: "1" });

    const messages: string[] = [];
    const batchResult = await runOnce(result.db, { listEscrows: listEscrowsReturning([badRow, goodRow]), log: (m) => messages.push(m) });

    assert.equal(batchResult.anomalies, 1);
    assert.equal(batchResult.applied, 1);
    assert.equal((await getBooking(result.db, badSeed.bookingId))?.escrowState, null);
    assert.equal((await getBooking(result.db, goodSeed.bookingId))?.escrowState, "locked");
    assert.ok(messages.some((m) => m.includes("non-integer lastLedgerSeq")));
  } finally {
    closeDatabase(result);
  }
});

test("a row with no snapshot.roles is an anomaly and does not abort the batch -- a following valid row still applies", async () => {
  const result = openTestDatabase();
  try {
    const badSeed = await seedReconcilableBooking(result);
    const goodSeed = await seedReconcilableBooking(result);
    const badRow = fakeEscrowRow(badSeed, {
      snapshot: { ...baseSnapshot({}, badSeed), roles: undefined as never },
    });
    const goodRow = fakeEscrowRow(goodSeed, { status: "active", balance: "1" });

    const messages: string[] = [];
    const batchResult = await runOnce(result.db, { listEscrows: listEscrowsReturning([badRow, goodRow]), log: (m) => messages.push(m) });

    assert.equal(batchResult.anomalies, 1);
    assert.equal(batchResult.applied, 1);
    assert.equal((await getBooking(result.db, badSeed.bookingId))?.escrowState, null);
    assert.equal((await getBooking(result.db, goodSeed.bookingId))?.escrowState, "locked");
  } finally {
    closeDatabase(result);
  }
});

test("an escrow whose engagementId does not match its booking is an anomaly, no state change, batch continues", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    // `engagementId` lives at the top level of `EscrowSummary` -- the field
    // `checkEscrowMatchesBooking` actually reads.
    const topLevelMismatch = fakeEscrowRow(seed, { engagementId: randomBookingId() });
    const messages: string[] = [];
    const outcome = await processEscrowRow(
      result.db,
      (await getBooking(result.db, seed.bookingId))!,
      seed.providerAddress,
      PLATFORM_ADDRESS,
      topLevelMismatch,
      (m) => messages.push(m),
    );
    assert.equal(outcome, "anomaly");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, null);
    assert.ok(messages.some((m) => m.includes("anomaly")));
  } finally {
    closeDatabase(result);
  }
});

test("checkEscrowMatchesBooking refuses an empty platformAddress with a typed EscrowConfigError", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const booking = (await getBooking(result.db, seed.bookingId))!;
    assert.throws(() => checkEscrowMatchesBooking(booking, seed.providerAddress, "", fakeEscrowRow(seed)), EscrowConfigError);
  } finally {
    closeDatabase(result);
  }
});

test("checkEscrowMatchesBooking catches one mismatch per role, the milestone approvalsTarget, and the amount", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const booking = (await getBooking(result.db, seed.bookingId))!;
    const goodRow = fakeEscrowRow(seed);
    assert.equal(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, goodRow), undefined);

    const base = baseSnapshot({}, seed);
    const mismatched = (rolesOverride: Partial<typeof base.roles>) =>
      fakeEscrowRow(seed, {}, { roles: { ...base.roles, ...rolesOverride } });

    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, mismatched({ approvers: [fakeAddress()] })));
    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, mismatched({ serviceProviders: [fakeAddress()] })));
    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, mismatched({ releaseSigners: [fakeAddress()] })));
    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, mismatched({ receiver: fakeAddress() })));
    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, mismatched({ disputeResolvers: [fakeAddress()] })));
    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, mismatched({ platform: fakeAddress() })));
    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, mismatched({ admin: fakeAddress() })));

    const wrongApprovalsTarget = fakeEscrowRow(seed, {}, { milestones: [{ description: "session", approvalsTarget: 2 }] });
    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, wrongApprovalsTarget));

    const wrongAmount = fakeEscrowRow(seed, {}, { amount: "0.5" });
    assert.ok(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, wrongAmount));
  } finally {
    closeDatabase(result);
  }
});

test("checkEscrowMatchesBooking compares the amount as BigInt, so a deposit with leading zeros still matches", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const booking = { ...(await getBooking(result.db, seed.bookingId))!, depositAmount: "0000010000000" };
    const row = fakeEscrowRow(seed, {}, { amount: "1" }); // 1 * 1e7 === 10_000_000, same value as the padded string
    assert.equal(checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, row), undefined);
  } finally {
    closeDatabase(result);
  }
});

test("checkEscrowMatchesBooking falls back to the root asset.contractId when the snapshot's own trustline contractId is empty", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const booking = (await getBooking(result.db, seed.bookingId))!;

    const fallbackMatches = fakeEscrowRow(
      seed,
      { asset: { name: "USDC", address: seed.tokenAddress, contractId: seed.tokenAddress } },
      { trustline: { address: seed.tokenAddress, symbol: "USDC" } }, // no contractId on the snapshot's own trustline
    );
    assert.equal(
      checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, fallbackMatches),
      undefined,
      "the root asset.contractId must be trusted when the snapshot's own trustline carries none",
    );

    const neitherMatches = fakeEscrowRow(
      seed,
      { asset: { name: "USDC", address: fakeContractId(), contractId: fakeContractId() } },
      { trustline: { address: seed.tokenAddress, symbol: "USDC" } },
    );
    assert.ok(
      checkEscrowMatchesBooking(booking, seed.providerAddress, PLATFORM_ADDRESS, neitherMatches),
      "neither the snapshot trustline nor the root asset naming the booking's token is a mismatch, not a silent pass",
    );
  } finally {
    closeDatabase(result);
  }
});

test("a row for an unrequested contractId is ignored as an anomaly, no row invented, batch continues (batch level)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const wantedRow = fakeEscrowRow(seed, { status: "active", balance: "1" });
    const unrequestedRow = fakeEscrowRow(
      { ...seed, contractId: fakeContractId(), bookingId: randomBookingId() },
      { status: "active", balance: "1" },
    );

    const messages: string[] = [];
    const batchResult = await runOnce(result.db, {
      listEscrows: listEscrowsReturning([wantedRow, unrequestedRow]),
      log: (m) => messages.push(m),
    });

    assert.equal(batchResult.applied, 1);
    assert.equal(batchResult.anomalies, 1);
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "locked");
    assert.ok(messages.some((m) => m.includes("not among the requested")));
  } finally {
    closeDatabase(result);
  }
});

test("runReconcilerOnce running twice over the same rows changes nothing observable the second time", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "active", balance: "1" });

    const first = await runOnce(result.db, { listEscrows: listEscrowsReturning([row]) });
    assert.equal(first.applied, 1);
    const bookingAfterFirst = await getBooking(result.db, seed.bookingId);

    const second = await runOnce(result.db, { listEscrows: listEscrowsReturning([row]) });
    assert.equal(second.applied, 0);
    assert.equal(second.skipped, 1, "the exact same row, at the exact same ledgerSeq, must be skipped by the watermark");
    const bookingAfterSecond = await getBooking(result.db, seed.bookingId);
    assert.deepEqual(bookingAfterSecond, bookingAfterFirst);
  } finally {
    closeDatabase(result);
  }
});

test("a restarted reconciler resumes from the stored per-escrow watermark (batch level)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const fundedRow = fakeEscrowRow(seed, { status: "active", balance: "1", lastLedgerSeq: "100" });
    await runOnce(result.db, { listEscrows: listEscrowsReturning([fundedRow]) });
    assert.equal(await getEscrowWatermark(result.db, seed.contractId), "100");

    // "Restart": a fresh call, the escrow now shows a later ledgerSeq but
    // the exact same funded state -- no new transition should derive
    // (already locked), but the watermark must still be the gate that is
    // consulted, and it must have resumed from "100", not from nothing.
    const sameStateLaterLedger = fakeEscrowRow(seed, { status: "active", balance: "1", lastLedgerSeq: "150" });
    const restarted = await runOnce(result.db, { listEscrows: listEscrowsReturning([sameStateLaterLedger]) });
    assert.equal(restarted.applied, 0);
    assert.equal(restarted.duplicates, 1, "the funded action was already recorded for this contract");
    assert.equal(await getEscrowWatermark(result.db, seed.contractId), "150");
  } finally {
    closeDatabase(result);
  }
});

test("humanDecimalToSmallestUnits converts exactly, without floats, and refuses excess precision", () => {
  assert.equal(humanDecimalToSmallestUnits("1")?.toString(), "10000000");
  assert.equal(humanDecimalToSmallestUnits("1.5")?.toString(), "15000000");
  assert.equal(humanDecimalToSmallestUnits("0.0000001")?.toString(), "1");
  assert.equal(humanDecimalToSmallestUnits("0")?.toString(), "0");
  assert.equal(humanDecimalToSmallestUnits("1.00000001"), undefined, "more than 7 fractional digits is refused, not rounded");
  assert.equal(humanDecimalToSmallestUnits("not-a-number"), undefined);
  assert.equal(humanDecimalToSmallestUnits("-1"), undefined);
});

test("escrowStateForLifecycleAction maps every recognized action to the right escrow_state", () => {
  assert.equal(escrowStateForLifecycleAction("funded"), "locked");
  assert.equal(escrowStateForLifecycleAction("completed"), "locked");
  assert.equal(escrowStateForLifecycleAction("approved"), "locked");
  assert.equal(escrowStateForLifecycleAction("disputed"), "locked");
  assert.equal(escrowStateForLifecycleAction("released"), "released");
  assert.equal(escrowStateForLifecycleAction("resolved", "refund-client"), "refunded");
  assert.equal(escrowStateForLifecycleAction("resolved", "pay-provider"), "released");
  assert.throws(() => escrowStateForLifecycleAction("resolved"), TypeError);
});

test("deriveEscrowLifecycle evaluates the derivation order: a resolved dispute wins over a stale isDisputed flag, balance notwithstanding", () => {
  const seed: SeededBooking = {
    bookingId: randomBookingId(),
    clientAddress: fakeAddress(),
    providerAddress: fakeAddress(),
    tokenAddress: fakeContractId(),
    contractId: fakeContractId(),
  };
  const booking = { id: seed.bookingId, depositAmount: DEPOSIT_AMOUNT, clientWalletAddress: seed.clientAddress, tokenAddress: seed.tokenAddress } as BookingRow;
  const row = fakeEscrowRow(seed, { status: "disputed", balance: "0" }, { dispute: { isDisputed: true, reason: "x", resolved: true } });
  const derivation = deriveEscrowLifecycle(booking, row, {
    bookingId: seed.bookingId,
    contractId: seed.contractId,
    outcome: "pay-provider",
    txHash: "h",
    decidedAt: 1,
  });
  assert.deepEqual(derivation, { kind: "transition", action: "resolved", outcome: "pay-provider" });
});

test("a listEscrows network failure reaches the reconciler's caller as a typed EscrowRequestError, never the raw SDK error", async () => {
  await assert.rejects(
    () =>
      fetchOwnedEscrows(async () => {
        throw new TrustlessWorkNetworkError("fetch failed", 0, undefined);
      }, [StrKey.encodeContract(randomBytes(32))]),
    (error: unknown) => {
      assert.ok(error instanceof EscrowRequestError);
      assert.ok(!(error instanceof TrustlessWorkNetworkError));
      return true;
    },
  );
});

test("fetchOwnedEscrows throws a typed EscrowRequestError when nextCursor does not advance, rather than looping forever", async () => {
  const contractId = fakeContractId();
  const listEscrows: ReconcilerDeps["listEscrows"] = async () => ({
    data: [],
    hasMore: true,
    nextCursor: "stuck-cursor",
  });
  await assert.rejects(() => fetchOwnedEscrows(listEscrows, [contractId]), EscrowRequestError);
});

test("fetchOwnedEscrows follows every keyset page, keying its fake reply on the cursor it was actually sent", async () => {
  const contractIds = Array.from({ length: 3 }, () => fakeContractId());
  const rowFor = (contractId: string): EscrowSummary => ({
    network: "testnet",
    contractId,
    type: "single-release",
    engagementId: "b",
    status: "active",
    totalAmount: null,
    balance: "0",
    asset: null,
    lastLedgerSeq: "1",
    createdAt: "",
    updatedAt: "",
    snapshot: baseSnapshot({}, { bookingId: "b", clientAddress: "c", providerAddress: "p", tokenAddress: "t", contractId }),
  });

  const calls: Array<{ cursor?: string }> = [];
  const listEscrows: ReconcilerDeps["listEscrows"] = async (params) => {
    calls.push({ cursor: params.cursor });
    if (params.cursor === undefined) {
      return { data: [rowFor(contractIds[0]!)], hasMore: true, nextCursor: "cursor-2" };
    }
    if (params.cursor === "cursor-2") {
      return { data: [rowFor(contractIds[1]!), rowFor(contractIds[2]!)], hasMore: false, nextCursor: null };
    }
    throw new Error(`unexpected cursor "${params.cursor}"`);
  };

  const rows = await fetchOwnedEscrows(listEscrows, contractIds);
  assert.equal(rows.length, 3);
  assert.equal(calls.length, 2, "the second keyset page must be followed, not just the first");
  assert.equal(calls[0]?.cursor, undefined, "the first call must start from no cursor");
  assert.equal(calls[1]?.cursor, "cursor-2", "the second call must carry the first page's own nextCursor, not repeat the first");
});

test("fetchOwnedEscrows chunks more than 50 contractIds into multiple requests, each carrying at most 50, that together cover every id", async () => {
  const contractIds = Array.from({ length: 51 }, () => fakeContractId());
  const rowFor = (contractId: string): EscrowSummary => ({
    network: "testnet",
    contractId,
    type: "single-release",
    engagementId: "b",
    status: "active",
    totalAmount: null,
    balance: "0",
    asset: null,
    lastLedgerSeq: "1",
    createdAt: "",
    updatedAt: "",
    snapshot: baseSnapshot({}, { bookingId: "b", clientAddress: "c", providerAddress: "p", tokenAddress: "t", contractId }),
  });

  const requestedChunks: string[][] = [];
  const listEscrows: ReconcilerDeps["listEscrows"] = async (params) => {
    const chunk = params.contractIds ?? [];
    requestedChunks.push(chunk);
    return { data: chunk.map(rowFor), hasMore: false, nextCursor: null };
  };

  const rows = await fetchOwnedEscrows(listEscrows, contractIds);
  assert.equal(rows.length, 51);
  assert.equal(requestedChunks.length, 2, "51 ids over a chunk size of 50 must take two requests");
  for (const chunk of requestedChunks) {
    assert.ok(chunk.length <= 50, `each request must carry at most 50 contractIds, got ${chunk.length}`);
  }
  const coveredIds = new Set(requestedChunks.flat());
  for (const id of contractIds) {
    assert.ok(coveredIds.has(id), `contractId ${id} must appear in some chunk`);
  }
});

test("realListEscrows refuses an empty TRUSTLESS_WORK_API_URL before any network access", async () => {
  const listEscrows = realListEscrows({ apiUrl: "", apiKey: "some-key", platformAddress: fakeAddress() });
  // `listEscrows` throws synchronously (the client is constructed lazily,
  // on first call) -- wrapped in an `async` arrow so the throw becomes a
  // rejection `assert.rejects` can actually observe, rather than escaping
  // as a synchronous exception before the promise machinery ever runs.
  await assert.rejects(async () => listEscrows({ contractIds: [fakeContractId()] }), EscrowConfigError);
});

test("realListEscrows refuses an empty TRUSTLESS_WORK_API_KEY before any network access", async () => {
  const listEscrows = realListEscrows({ apiUrl: "https://dev.api.trustlesswork.com", apiKey: "", platformAddress: fakeAddress() });
  await assert.rejects(async () => listEscrows({ contractIds: [fakeContractId()] }), EscrowConfigError);
});

test("getEscrowLifecycle returns undefined for an unknown booking", async () => {
  const result = openTestDatabase();
  try {
    assert.equal(await getEscrowLifecycle(result.db, randomBookingId()), undefined);
  } finally {
    closeDatabase(result);
  }
});

test("getEscrowLifecycle returns the contractId with no action for a booking that has none recorded yet", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const lifecycle = await getEscrowLifecycle(result.db, seed.bookingId);
    assert.deepEqual(lifecycle, { contractId: seed.contractId });
  } finally {
    closeDatabase(result);
  }
});

test("getEscrowLifecycle returns the latest recorded action, and the outcome once resolved", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const fundedRow = fakeEscrowRow(seed, { status: "active", balance: "1", lastLedgerSeq: "100" });
    await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, fundedRow);

    let lifecycle = await getEscrowLifecycle(result.db, seed.bookingId);
    assert.equal(lifecycle?.action, "funded");
    assert.equal(lifecycle?.contractId, seed.contractId);
    assert.equal(lifecycle?.outcome, undefined);

    await recordEscrowDisputeResolution(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      outcome: "refund-client",
      txHash: "h",
      decidedAt: Date.now(),
    });
    const resolvedRow = fakeEscrowRow(
      seed,
      { status: "disputed", balance: "0", lastLedgerSeq: "200" },
      { dispute: { isDisputed: true, reason: "x", resolved: true } },
    );
    await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, resolvedRow);

    lifecycle = await getEscrowLifecycle(result.db, seed.bookingId);
    assert.equal(lifecycle?.action, "resolved");
    assert.equal(lifecycle?.outcome, "refund-client");
  } finally {
    closeDatabase(result);
  }
});

test("a failure between the dedupe insert and the escrow-state write leaves nothing committed, so the row is still re-processable", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const row = fakeEscrowRow(seed, { status: "active", balance: "1" });
    const bookingBeforeFailure = (await getBooking(result.db, seed.bookingId))!;

    await assert.rejects(() =>
      processEscrowRow(result.db, bookingBeforeFailure, seed.providerAddress, PLATFORM_ADDRESS, row, undefined, {
        updateEscrowState: () => {
          throw new Error("simulated failure between the dedupe insert and the escrow-state write");
        },
      }),
    );

    assert.equal(await getEscrowProcessedEvent(result.db, seed.contractId, "funded"), undefined);
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, null);

    const outcome = await processEscrowRow(result.db, (await getBooking(result.db, seed.bookingId))!, seed.providerAddress, PLATFORM_ADDRESS, row);
    assert.equal(outcome, "applied");
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "locked");
  } finally {
    closeDatabase(result);
  }
});

test("runReconcilerOnce with no reconcilable bookings does nothing and never calls listEscrows", async () => {
  const result = openTestDatabase();
  try {
    const batchResult = await runOnce(result.db, {
      listEscrows: async () => {
        throw new Error("listEscrows should not have been called");
      },
    });
    assert.deepEqual(batchResult, { applied: 0, duplicates: 0, anomalies: 0, skipped: 0 });
  } finally {
    closeDatabase(result);
  }
});

test("a released booking is excluded from getReconcilableBookings entirely (AC4)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    const releasedRow = fakeEscrowRow(seed, { status: "released", balance: "0" });
    await runOnce(result.db, { listEscrows: listEscrowsReturning([releasedRow]) });
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "released");

    let called = false;
    const secondRun = await runOnce(result.db, {
      listEscrows: async () => {
        called = true;
        return { data: [], hasMore: false, nextCursor: null };
      },
    });
    assert.equal(secondRun.applied, 0);
    assert.equal(called, false, "a terminal booking is excluded from the candidate set, so listEscrows is never even called");
  } finally {
    closeDatabase(result);
  }
});

test("a refunded booking is likewise excluded from getReconcilableBookings entirely (AC4)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedReconcilableBooking(result);
    await recordEscrowDisputeResolution(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      outcome: "refund-client",
      txHash: "resolve-tx-hash",
      decidedAt: Date.now(),
    });
    const resolvedRow = fakeEscrowRow(seed, { status: "disputed", balance: "0" }, { dispute: { isDisputed: true, reason: "x", resolved: true } });
    await runOnce(result.db, { listEscrows: listEscrowsReturning([resolvedRow]) });
    assert.equal((await getBooking(result.db, seed.bookingId))?.escrowState, "refunded");

    let called = false;
    await runOnce(result.db, {
      listEscrows: async () => {
        called = true;
        return { data: [], hasMore: false, nextCursor: null };
      },
    });
    assert.equal(called, false, "a refunded booking is excluded from the candidate set exactly like a released one");
  } finally {
    closeDatabase(result);
  }
});
