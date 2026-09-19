/**
 * Story 3.6's own additions to `services/booking.ts` -- `completeAppointment`,
 * `approveAppointment`, `releaseDeposit`, `openDispute`, `listOpenDisputes`,
 * and `submitSignedTransaction`'s extended hash-matching rule. No network
 * access anywhere: every action is driven through a fake `EscrowAdapter`.
 * Covers this story's own amended I/O matrix rows: role-correct ownership
 * (a wrong caller gets `BookingNotFoundError`, never revealing whether the
 * booking exists), the per-action lifecycle-state guard (a wrong state gets
 * `BookingEscrowStateError`), the suggested-outcome policy table, and the
 * submit allow-list extended to every new action's own stored hash.
 */
import "./testConfigEnv.js";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

import {
  BookingEscrowStateError,
  BookingNotFoundError,
  XdrMismatchError,
  approveAppointment,
  completeAppointment,
  listOpenDisputes,
  openDispute,
  releaseDeposit,
  resolveBookingDispute,
  submitSignedTransaction,
} from "../src/services/booking.js";
import { getBookingById, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import { getEscrowDisputeOpening } from "../src/db/escrowDisputeOpenings.js";
import type { Db } from "../src/db/client.js";
import type {
  ApproveEscrowInput,
  CompleteEscrowInput,
  EscrowAdapter,
  ReleaseEscrowInput,
  StartDisputeInput,
} from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function unreachableEscrowAdapter(): EscrowAdapter {
  return {
    deploy: async () => {
      throw new Error("deploy should not have been called");
    },
    fund: async () => {
      throw new Error("fund should not have been called");
    },
    complete: async () => {
      throw new Error("complete should not have been called");
    },
    approve: async () => {
      throw new Error("approve should not have been called");
    },
    release: async () => {
      throw new Error("release should not have been called");
    },
    startDispute: async () => {
      throw new Error("startDispute should not have been called");
    },
    resolveDispute: async () => {
      throw new Error("resolveDispute should not have been called");
    },
    submit: async () => {
      throw new Error("submit should not have been called");
    },
  };
}

/** Seeds a locked booking with a persisted contractId, ready for a Story
 * 3.6 action -- optionally at a given point in its recorded lifecycle
 * (`"funded"` by default, matching a freshly-locked deposit). */
async function seedLockedBooking(
  result: Awaited<ReturnType<typeof openTestDatabase>>,
  options: {
    clientWalletAddress?: string;
    providerWalletAddress?: string;
    cancelDeadline?: number;
    lifecycleAction?: "funded" | "completed" | "approved" | "disputed";
  } = {},
): Promise<{ bookingId: string; contractId: string; clientWalletAddress: string; providerWalletAddress: string }> {
  const clientWalletAddress = options.clientWalletAddress ?? Keypair.random().publicKey();
  const providerWalletAddress = options.providerWalletAddress ?? Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
  const bookingId = await seedBooking(result, {
    providerProfileId,
    clientWalletAddress,
    cancelDeadline: options.cancelDeadline ?? Math.floor(Date.now() / 1000) + 3600,
  });
  const contractId = fakeContractId();
  await updateEscrowContractId(result.db, bookingId, contractId);
  updateEscrowStateSync(result.db, bookingId, "locked");
  const action = options.lifecycleAction ?? "funded";
  await insertEscrowProcessedEventIfNew(result.db, {
    bookingId,
    contractId,
    lifecycleAction: action,
    amount: "1000000",
    ledgerSeq: "1",
    isAnomaly: false,
    processedAt: Date.now(),
  });
  return { bookingId, contractId, clientWalletAddress, providerWalletAddress };
}

/** A real, decodable (never submitted) transaction envelope and its own
 * hash -- signing never changes the hash `submitSignedTransaction` matches
 * against, so this is enough without a real wallet signature (mirrors
 * `services-booking-hold.test.ts`'s own helper). */
function buildFakeTransactionXdr(): { xdr: string; hash: string } {
  const account = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
    .setTimeout(30)
    .build();
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
}

// ---------------------------------------------------------------------------
// completeAppointment
// ---------------------------------------------------------------------------

test("completeAppointment: the provider completes a funded booking, and its txHash is stored for submit binding", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    let captured: CompleteEscrowInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      complete: async (input) => {
        captured = input;
        return { unsignedXdr: "complete-unsigned-xdr", txHash: "complete-tx-hash" };
      },
    };

    const result2 = await completeAppointment(result.db, seed.bookingId, seed.providerWalletAddress, adapter);
    assert.equal(result2.unsignedXdr, "complete-unsigned-xdr");
    assert.ok(captured);
    assert.equal(captured.contractId, seed.contractId);
    assert.equal(captured.providerAddress, seed.providerWalletAddress);

    const booking = await getBookingById(result.db, seed.bookingId);
    assert.equal(booking?.escrowCompleteTxHash, "complete-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("completeAppointment: the client (or any other wallet) gets 404, never reaching the adapter", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    await assert.rejects(
      () => completeAppointment(result.db, seed.bookingId, seed.clientWalletAddress, unreachableEscrowAdapter()),
      BookingNotFoundError,
    );
    await assert.rejects(
      () => completeAppointment(result.db, seed.bookingId, Keypair.random().publicKey(), unreachableEscrowAdapter()),
      BookingNotFoundError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("completeAppointment: refuses (409-shaped) a booking that is not locked", async () => {
  const result = openTestDatabase();
  try {
    const providerWalletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
    const bookingId = await seedBooking(result, { providerProfileId });
    await assert.rejects(
      () => completeAppointment(result.db, bookingId, providerWalletAddress, unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("completeAppointment: refuses once the appointment has already moved past 'funded' (e.g. already completed)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "completed" });
    await assert.rejects(
      () => completeAppointment(result.db, seed.bookingId, seed.providerWalletAddress, unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// approveAppointment
// ---------------------------------------------------------------------------

test("approveAppointment: the client approves from 'funded'", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "funded" });
    let captured: ApproveEscrowInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      approve: async (input) => {
        captured = input;
        return { unsignedXdr: "approve-unsigned-xdr", txHash: "approve-tx-hash" };
      },
    };
    await approveAppointment(result.db, seed.bookingId, seed.clientWalletAddress, adapter);
    assert.ok(captured);
    assert.equal(captured.contractId, seed.contractId);
    assert.equal(captured.clientAddress, seed.clientWalletAddress);

    const booking = await getBookingById(result.db, seed.bookingId);
    assert.equal(booking?.escrowApproveTxHash, "approve-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("approveAppointment: the client approves from 'completed' too", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "completed" });
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      approve: async () => ({ unsignedXdr: "x", txHash: "approve-tx-hash-2" }),
    };
    const approveResult = await approveAppointment(result.db, seed.bookingId, seed.clientWalletAddress, adapter);
    assert.equal(approveResult.txHash, "approve-tx-hash-2");
  } finally {
    closeDatabase(result);
  }
});

test("approveAppointment: the provider gets 404", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    await assert.rejects(
      () => approveAppointment(result.db, seed.bookingId, seed.providerWalletAddress, unreachableEscrowAdapter()),
      BookingNotFoundError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("approveAppointment: refuses once already 'approved' or 'disputed'", async () => {
  const result = openTestDatabase();
  try {
    const approved = await seedLockedBooking(result, { lifecycleAction: "approved" });
    await assert.rejects(
      () => approveAppointment(result.db, approved.bookingId, approved.clientWalletAddress, unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
    const disputed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    await assert.rejects(
      () => approveAppointment(result.db, disputed.bookingId, disputed.clientWalletAddress, unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// releaseDeposit
// ---------------------------------------------------------------------------

test("releaseDeposit: the provider releases once 'approved'", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "approved" });
    let captured: ReleaseEscrowInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      release: async (input) => {
        captured = input;
        return { unsignedXdr: "release-unsigned-xdr", txHash: "release-tx-hash" };
      },
    };
    await releaseDeposit(result.db, seed.bookingId, seed.providerWalletAddress, adapter);
    assert.ok(captured);
    assert.equal(captured.contractId, seed.contractId);
    assert.equal(captured.providerAddress, seed.providerWalletAddress);

    const booking = await getBookingById(result.db, seed.bookingId);
    assert.equal(booking?.escrowReleaseTxHash, "release-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("releaseDeposit: the client gets 404", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "approved" });
    await assert.rejects(
      () => releaseDeposit(result.db, seed.bookingId, seed.clientWalletAddress, unreachableEscrowAdapter()),
      BookingNotFoundError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("releaseDeposit: refuses from 'funded'/'completed'/'disputed' -- only 'approved' releases", async () => {
  const result = openTestDatabase();
  try {
    for (const lifecycleAction of ["funded", "completed", "disputed"] as const) {
      const seed = await seedLockedBooking(result, { lifecycleAction });
      await assert.rejects(
        () => releaseDeposit(result.db, seed.bookingId, seed.providerWalletAddress, unreachableEscrowAdapter()),
        BookingEscrowStateError,
        `release must refuse from "${lifecycleAction}"`,
      );
    }
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// openDispute -- ownership, state guard, and the suggested-outcome policy
// ---------------------------------------------------------------------------

test("openDispute: either the client or the provider may open one, each signing as themselves", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "funded" });
    let captured: StartDisputeInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      startDispute: async (input) => {
        captured = input;
        return { unsignedXdr: "dispute-unsigned-xdr", txHash: "dispute-tx-hash" };
      },
    };
    const disputeResult = await openDispute(result.db, seed.bookingId, seed.clientWalletAddress, "disagreement", adapter);
    assert.equal(disputeResult.reason, "disagreement");
    assert.equal(disputeResult.suggestedOutcome, undefined, "disagreement carries no policy-implied outcome");
    assert.ok(captured);
    assert.equal(captured.contractId, seed.contractId);
    assert.equal(captured.signerAddress, seed.clientWalletAddress);

    const booking = await getBookingById(result.db, seed.bookingId);
    assert.equal(booking?.escrowDisputeTxHash, "dispute-tx-hash");
    const opening = await getEscrowDisputeOpening(result.db, seed.bookingId);
    assert.equal(opening?.openedByWallet, seed.clientWalletAddress);
    assert.equal(opening?.reason, "disagreement");
    assert.equal(opening?.suggestedOutcome, null);
  } finally {
    closeDatabase(result);
  }
});

test("openDispute: the provider can also open one, naming itself as the signer", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "funded" });
    let captured: StartDisputeInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      startDispute: async (input) => {
        captured = input;
        return { unsignedXdr: "x", txHash: "dispute-tx-hash-2" };
      },
    };
    await openDispute(result.db, seed.bookingId, seed.providerWalletAddress, "no-show", adapter);
    assert.ok(captured);
    assert.equal(captured.signerAddress, seed.providerWalletAddress);
  } finally {
    closeDatabase(result);
  }
});

test("openDispute: suggested outcome follows the cancellation policy (who cancels decides)", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      startDispute: async () => ({ unsignedXdr: "x", txHash: `h-${Math.random()}` }),
    };

    const providerCancel = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const providerCancelResult = await openDispute(result.db, providerCancel.bookingId, providerCancel.providerWalletAddress, "provider-cancel", adapter, now);
    assert.equal(providerCancelResult.suggestedOutcome, "refund-client");

    const noShow = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const noShowResult = await openDispute(result.db, noShow.bookingId, noShow.providerWalletAddress, "no-show", adapter, now);
    assert.equal(noShowResult.suggestedOutcome, "pay-provider");

    const clientCancelBeforeDeadline = await seedLockedBooking(result, { lifecycleAction: "funded", cancelDeadline: now + 3600 });
    const beforeResult = await openDispute(
      result.db,
      clientCancelBeforeDeadline.bookingId,
      clientCancelBeforeDeadline.clientWalletAddress,
      "client-cancel",
      adapter,
      now,
    );
    assert.equal(beforeResult.suggestedOutcome, "refund-client", "before the deadline, the client's cancellation refunds in full");

    const clientCancelAfterDeadline = await seedLockedBooking(result, { lifecycleAction: "funded", cancelDeadline: now - 3600 });
    const afterResult = await openDispute(
      result.db,
      clientCancelAfterDeadline.bookingId,
      clientCancelAfterDeadline.clientWalletAddress,
      "client-cancel",
      adapter,
      now,
    );
    assert.equal(afterResult.suggestedOutcome, "pay-provider", "after the deadline, the full deposit is suggested for the provider");
  } finally {
    closeDatabase(result);
  }
});

test("openDispute: a wallet that is neither the client nor the provider gets 404", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    await assert.rejects(
      () => openDispute(result.db, seed.bookingId, Keypair.random().publicKey(), "disagreement", unreachableEscrowAdapter()),
      BookingNotFoundError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("openDispute: refuses (409-shaped) once the booking is not locked, or already disputed", async () => {
  const result = openTestDatabase();
  try {
    const providerWalletAddress = Keypair.random().publicKey();
    const clientWalletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
    const neverLockedBookingId = await seedBooking(result, { providerProfileId, clientWalletAddress });
    await assert.rejects(
      () => openDispute(result.db, neverLockedBookingId, clientWalletAddress, "disagreement", unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );

    const alreadyDisputed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    await assert.rejects(
      () => openDispute(result.db, alreadyDisputed.bookingId, alreadyDisputed.clientWalletAddress, "disagreement", unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// resolveBookingDispute also stores its own txHash on the booking row, for
// submitSignedTransaction's extended hash-matching rule.
// ---------------------------------------------------------------------------

test("resolveBookingDispute stores its own txHash on the booking row (not only escrow_dispute_resolutions)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      resolveDispute: async () => ({ unsignedXdr: "x", txHash: "resolve-tx-hash" }),
    };
    await resolveBookingDispute(result.db, seed.bookingId, "refund-client", adapter);
    const booking = await getBookingById(result.db, seed.bookingId);
    assert.equal(booking?.escrowResolveTxHash, "resolve-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// submitSignedTransaction's hash-matching rule extended to every Story 3.6
// action (complete/approve/release/dispute/resolve), not only deploy/fund.
// ---------------------------------------------------------------------------

test("submitSignedTransaction relays a signed envelope matching any Story 3.6 action's stored txHash", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const cases: Array<{ column: "escrowCompleteTxHash" | "escrowApproveTxHash" | "escrowReleaseTxHash" | "escrowDisputeTxHash" | "escrowResolveTxHash" }> = [
      { column: "escrowCompleteTxHash" },
      { column: "escrowApproveTxHash" },
      { column: "escrowReleaseTxHash" },
      { column: "escrowDisputeTxHash" },
      { column: "escrowResolveTxHash" },
    ];
    for (const { column } of cases) {
      const { xdr, hash } = buildFakeTransactionXdr();
      const { bookings } = await import("../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      await result.db.update(bookings).set({ [column]: hash }).where(eq(bookings.id, seed.bookingId));

      let submitted: string | undefined;
      const adapter: EscrowAdapter = {
        ...unreachableEscrowAdapter(),
        submit: async (signedXdr) => {
          submitted = signedXdr;
          return { txHash: `relayed-${column}` };
        },
      };
      const submitResult = await submitSignedTransaction(result.db, seed.bookingId, xdr, adapter);
      assert.equal(submitResult.txHash, `relayed-${column}`);
      assert.equal(submitted, xdr, `submit must have been called for ${column}`);
    }
  } finally {
    closeDatabase(result);
  }
});

test("submitSignedTransaction refuses a signed envelope matching none of the booking's own stored hashes", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const { xdr } = buildFakeTransactionXdr();
    await assert.rejects(() => submitSignedTransaction(result.db, seed.bookingId, xdr, unreachableEscrowAdapter()), XdrMismatchError);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// listOpenDisputes -- the admin "Resolutions" list's own read
// ---------------------------------------------------------------------------

test("listOpenDisputes returns only bookings whose current lifecycle action is still 'disputed', with the reason, suggested outcome and amount", async () => {
  const result = openTestDatabase();
  try {
    const disputeAdapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      startDispute: async () => ({ unsignedXdr: "x", txHash: `h-${Math.random()}` }),
    };

    const openOne = await seedLockedBooking(result, { lifecycleAction: "funded" });
    await openDispute(result.db, openOne.bookingId, openOne.providerWalletAddress, "no-show", disputeAdapter);
    // The reconciler's own later chain confirmation that the dispute
    // actually landed -- `openDispute` itself only relays the unsigned
    // start-dispute XDR and records the *opening*, never the lifecycle
    // action itself (that is always chain-derived).
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: openOne.bookingId,
      contractId: openOne.contractId,
      lifecycleAction: "disputed",
      amount: "1000000",
      ledgerSeq: "2",
      isAnomaly: false,
      processedAt: Date.now(),
    });

    // A booking that was disputed and then resolved must not appear in the
    // open list anymore -- `resolveBookingDispute` itself only ever runs
    // once the reconciler has chain-confirmed a "disputed" transition (a
    // separate step from `openDispute`, which only relays the unsigned
    // start-dispute XDR), so that confirmation is seeded directly here.
    const resolvedOne = await seedLockedBooking(result, { lifecycleAction: "funded" });
    await openDispute(result.db, resolvedOne.bookingId, resolvedOne.clientWalletAddress, "disagreement", disputeAdapter);
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: resolvedOne.bookingId,
      contractId: resolvedOne.contractId,
      lifecycleAction: "disputed",
      amount: "1000000",
      ledgerSeq: "2",
      isAnomaly: false,
      processedAt: Date.now(),
    });
    const resolveAdapter: EscrowAdapter = { ...unreachableEscrowAdapter(), resolveDispute: async () => ({ unsignedXdr: "x", txHash: "resolve-h" }) };
    await resolveBookingDispute(result.db, resolvedOne.bookingId, "refund-client", resolveAdapter);
    // And the reconciler's own later confirmation that the resolution
    // landed on chain -- `resolveBookingDispute` itself never records this;
    // only a chain-derived "resolved" transition does.
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: resolvedOne.bookingId,
      contractId: resolvedOne.contractId,
      lifecycleAction: "resolved",
      amount: "0",
      ledgerSeq: "3",
      isAnomaly: false,
      processedAt: Date.now(),
    });

    // A booking that never disputed at all must not appear either.
    await seedLockedBooking(result, { lifecycleAction: "funded" });

    const disputes = await listOpenDisputes(result.db);
    assert.equal(disputes.length, 1);
    const [dispute] = disputes;
    assert.equal(dispute?.bookingId, openOne.bookingId);
    assert.equal(dispute?.openedByWallet, openOne.providerWalletAddress);
    assert.equal(dispute?.reason, "no-show");
    assert.equal(dispute?.suggestedOutcome, "pay-provider");
    assert.equal(dispute?.clientWalletAddress, openOne.clientWalletAddress);
    assert.equal(dispute?.provider.displayName, "Test Provider");
    assert.ok(dispute?.amount.amount);
  } finally {
    closeDatabase(result);
  }
});

test("listOpenDisputes returns an empty list when there are no disputes at all", async () => {
  const result = openTestDatabase();
  try {
    assert.deepEqual(await listOpenDisputes(result.db), []);
  } finally {
    closeDatabase(result);
  }
});
