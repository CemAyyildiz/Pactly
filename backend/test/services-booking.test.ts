/**
 * `services/booking.ts` exercised as a unit -- no network access anywhere:
 * `lockDeposit`/`fundDeposit`/`resolveBookingDispute` are driven through a
 * fake `EscrowAdapter` that never constructs a real `TrustlessWorkClient`.
 * Covers this story's own amended I/O matrix rows: `lockDeposit`'s argument
 * wiring (a reversed professional/client pair would lock a deposit payable
 * to the wrong party) and its persisted `contractId`; the typed refusals
 * for a redeploy/refund/re-resolve once state has already moved on;
 * `fundDeposit` targeting exactly the persisted `contractId`, never a
 * caller-supplied one; and `resolveBookingDispute`'s one full-amount
 * distribution plus its recorded decision.
 */
import "./testConfigEnv.js";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { BookingEscrowStateError, fundDeposit, lockDeposit, resolveBookingDispute, setBalanceState } from "../src/services/booking.js";
import { getEscrowDisputeResolution } from "../src/db/escrowDisputeResolutions.js";
import { getBookingById, recordDeploySubmission, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { bookings } from "../src/db/schema.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import type { Db } from "../src/db/client.js";
import type {
  DeployEscrowInput,
  DeployEscrowResult,
  EscrowAdapter,
  FundEscrowInput,
  ResolveDisputeInput,
  UnsignedTransaction,
} from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, randomBookingId, seedBooking, seedProviderProfile } from "./helpers.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

/** Seeds the reconciler's own record of a "disputed" transition for
 * `contractId` -- `resolveBookingDispute` now refuses to build a
 * resolution without one (it must never resolve a dispute the chain has
 * not actually confirmed exists). */
async function markDisputed(db: Db, bookingId: string, contractId: string, amount: string): Promise<void> {
  await insertEscrowProcessedEventIfNew(db, {
    bookingId,
    contractId,
    lifecycleAction: "disputed",
    amount,
    ledgerSeq: "1",
    isAnomaly: false,
    processedAt: Date.now(),
  });
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

test("lockDeposit calls the EscrowAdapter's deploy with the professional's wallet as the provider, never the client's, and persists the contractId", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const tokenAddress = fakeContractId();
    const depositAmount = "5000000";

    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientAddress,
      tokenAddress,
      depositAmount,
    });

    let capturedDeploy: DeployEscrowInput | undefined;
    const deployResult: DeployEscrowResult = {
      contractId: fakeContractId(),
      unsignedXdr: "deploy-unsigned-xdr",
      txHash: "deploy-tx-hash",
    };

    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async (input: DeployEscrowInput) => {
        capturedDeploy = input;
        return deployResult;
      },
    };

    const lockResult = await lockDeposit(result.db, bookingId, adapter);

    assert.equal(lockResult.contractId, deployResult.contractId);
    assert.equal(lockResult.deployed, false);
    if (!lockResult.deployed) {
      assert.equal(lockResult.unsignedXdr, deployResult.unsignedXdr);
      assert.equal(lockResult.txHash, deployResult.txHash);
    }

    assert.ok(capturedDeploy, "adapter.deploy should have been called");
    assert.equal(capturedDeploy.bookingId, bookingId);
    assert.equal(capturedDeploy.providerAddress, professionalWallet, "provider must be the provider profile's wallet");
    assert.equal(capturedDeploy.clientAddress, clientAddress, "client must be the booking's own client wallet");
    assert.notEqual(capturedDeploy.providerAddress, capturedDeploy.clientAddress, "provider and client must not have been swapped");
    assert.equal(capturedDeploy.tokenAddress, tokenAddress);
    assert.equal(capturedDeploy.amount, depositAmount);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, deployResult.contractId, "the predicted contractId must be persisted");
    assert.equal(booking?.escrowState, null, "lockDeposit alone must never set escrow_state");
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit throws for an unknown booking id without ever calling the adapter", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => lockDeposit(result.db, randomBookingId(), unreachableEscrowAdapter()), TypeError);
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit retried within the hold returns the same stored deploy XDR and contractId, without a second deploy call (Story 3.4)", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const firstContractId = fakeContractId();
    let calls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        calls += 1;
        return { contractId: firstContractId, unsignedXdr: "first-unsigned-xdr", txHash: "h" };
      },
    };

    const first = await lockDeposit(result.db, bookingId, adapter);
    assert.equal(calls, 1);
    assert.equal(first.contractId, firstContractId);
    assert.equal(first.deployed, false);
    if (!first.deployed) assert.equal(first.unsignedXdr, "first-unsigned-xdr");

    // A retry (a declined wallet signature, or a lost response) must return
    // the exact same escrow and XDR, never deploy a second, competing one.
    const second = await lockDeposit(result.db, bookingId, unreachableEscrowAdapter());
    assert.equal(calls, 1, "the adapter's deploy must not be called again");
    assert.equal(second.contractId, firstContractId);
    assert.equal(second.deployed, false);
    if (!second.deployed) assert.equal(second.unsignedXdr, "first-unsigned-xdr");

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, firstContractId, "the original contractId must survive the retried call");
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit returns {deployed: true, contractId} once a deploy submission is recorded, without touching the adapter", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    const recorded = await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));
    assert.equal(recorded, true);

    const lockResult = await lockDeposit(result.db, bookingId, unreachableEscrowAdapter());
    assert.deepEqual(lockResult, { deployed: true, contractId });
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit refuses (typed) when a contractId is persisted with no stored XDR and rebuild is not requested", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);

    await assert.rejects(() => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, contractId, "the contractId must survive the refusal");
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit with rebuild: true clears an unsubmitted deploy and builds a fresh one", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const staleContractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, staleContractId, "stale-xdr", "stale-tx-hash");

    const freshContractId = fakeContractId();
    let calls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        calls += 1;
        return { contractId: freshContractId, unsignedXdr: "fresh-unsigned-xdr", txHash: "fresh-tx-hash" };
      },
    };

    const rebuilt = await lockDeposit(result.db, bookingId, adapter, { rebuild: true });
    assert.equal(calls, 1);
    assert.equal(rebuilt.contractId, freshContractId);
    assert.equal(rebuilt.deployed, false);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, freshContractId);
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit ignores rebuild: true once a deploy submission is already recorded", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));

    const lockResult = await lockDeposit(result.db, bookingId, unreachableEscrowAdapter(), { rebuild: true });
    assert.deepEqual(lockResult, { deployed: true, contractId });
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit: two concurrent first-deploy calls never let a raw TypeError escape -- one wins, the other returns its result", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    let deployCalls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        deployCalls += 1;
        return { contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" };
      },
    };

    const [first, second] = await Promise.all([lockDeposit(result.db, bookingId, adapter), lockDeposit(result.db, bookingId, adapter)]);
    // Both calls can legitimately race to build a deploy (each reads
    // `contractId: null` before either has written) -- the guarantee is at
    // the *write*: only one persists, and neither call ever throws a raw,
    // untyped error. Both must end up agreeing on the same, single
    // persisted contractId.
    assert.ok(deployCalls >= 1);
    assert.equal(first.contractId, contractId);
    assert.equal(second.contractId, contractId);
    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, contractId);
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit refuses once the hold has expired with escrow_state still null", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const past = Math.floor(Date.now() / 1000) - 1;
    await result.db.update(bookings).set({ holdExpiresAt: past }).where(eq(bookings.id, bookingId));

    await assert.rejects(
      () => lockDeposit(result.db, bookingId, unreachableEscrowAdapter(), { now: past + 1 }),
      (error: unknown) => error instanceof Error && error.name === "BookingHoldExpiredError",
    );
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit refuses to run again once escrow_state is also set", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await updateEscrowContractId(result.db, bookingId, fakeContractId());
    updateEscrowStateSync(result.db, bookingId, "locked");

    await assert.rejects(() => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit targets exactly the persisted contractId, never a caller-supplied one, once a deploy submission is recorded", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const depositAmount = "5000000";
    const bookingId = await seedBooking(result, { clientWalletAddress: clientAddress, depositAmount });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));

    let capturedFund: FundEscrowInput | undefined;
    const fundResult: UnsignedTransaction = { unsignedXdr: "fund-unsigned-xdr", txHash: "fund-tx-hash" };
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      fund: async (input: FundEscrowInput) => {
        capturedFund = input;
        return fundResult;
      },
    };

    const result2 = await fundDeposit(result.db, bookingId, adapter);
    assert.deepEqual(result2, fundResult);
    assert.ok(capturedFund);
    assert.equal(capturedFund.contractId, contractId);
    assert.equal(capturedFund.clientAddress, clientAddress);
    assert.equal(capturedFund.amount, depositAmount);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowFundTxHash, "fund-tx-hash", "the built fund XDR's own txHash must be stored for submitSignedTransaction to match against");
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit refuses when no contractId is persisted yet", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await assert.rejects(() => fundDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit refuses when a contractId is persisted but no deploy submission has been recorded yet (Story 3.4 review)", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await updateEscrowContractId(result.db, bookingId, fakeContractId(), "unsigned-xdr", "deploy-tx-hash");
    // No recordDeploySubmission call -- the deploy was built but never
    // confirmed relayed.
    await assert.rejects(() => fundDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit refuses once escrow_state is already set", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));
    updateEscrowStateSync(result.db, bookingId, "locked");

    await assert.rejects(() => fundDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit refuses once the hold has expired with escrow_state still null (Story 3.4 review)", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    const past = Math.floor(Date.now() / 1000) - 1;
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", past, past - 600);
    await result.db.update(bookings).set({ holdExpiresAt: past }).where(eq(bookings.id, bookingId));

    await assert.rejects(
      () => fundDeposit(result.db, bookingId, unreachableEscrowAdapter(), { now: past + 1 }),
      (error: unknown) => error instanceof Error && error.name === "BookingHoldExpiredError",
    );
  } finally {
    closeDatabase(result);
  }
});

test("resolveBookingDispute refuses unless the booking is locked with a persisted contractId", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await assert.rejects(
      () => resolveBookingDispute(result.db, bookingId, "refund-client", unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("resolveBookingDispute refuses when the booking is locked but no chain-confirmed dispute is recorded for its contractId", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await updateEscrowContractId(result.db, bookingId, fakeContractId());
    updateEscrowStateSync(result.db, bookingId, "locked");

    // No `markDisputed` here -- `escrow_state` alone reading "locked" is
    // also true before any dispute ever existed, so it must not be enough.
    await assert.rejects(
      () => resolveBookingDispute(result.db, bookingId, "refund-client", unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("resolveBookingDispute (refund-client) builds one full-amount distribution to the client and records the decision", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000";
    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress: clientAddress, depositAmount });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await markDisputed(result.db, bookingId, contractId, depositAmount);

    let captured: ResolveDisputeInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      resolveDispute: async (input: ResolveDisputeInput) => {
        captured = input;
        return { unsignedXdr: "resolve-unsigned-xdr", txHash: "resolve-tx-hash" };
      },
    };

    const outcome = await resolveBookingDispute(result.db, bookingId, "refund-client", adapter);
    assert.equal(outcome.outcome, "refund-client");
    assert.equal(outcome.txHash, "resolve-tx-hash");

    assert.ok(captured);
    assert.equal(captured.contractId, contractId);
    assert.deepEqual(captured.distributions, [{ address: clientAddress, amount: depositAmount }]);

    const recorded = await getEscrowDisputeResolution(result.db, bookingId);
    assert.equal(recorded?.outcome, "refund-client");
    assert.equal(recorded?.txHash, "resolve-tx-hash");
    assert.equal(recorded?.contractId, contractId);
  } finally {
    closeDatabase(result);
  }
});

test("resolveBookingDispute (pay-provider) builds one full-amount distribution to the provider's own wallet", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000";
    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress: clientAddress, depositAmount });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await markDisputed(result.db, bookingId, contractId, depositAmount);

    let captured: ResolveDisputeInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      resolveDispute: async (input: ResolveDisputeInput) => {
        captured = input;
        return { unsignedXdr: "resolve-unsigned-xdr", txHash: "resolve-tx-hash-2" };
      },
    };

    const outcome = await resolveBookingDispute(result.db, bookingId, "pay-provider", adapter);
    assert.equal(outcome.outcome, "pay-provider");
    assert.ok(captured);
    assert.deepEqual(captured.distributions, [{ address: professionalWallet, amount: depositAmount }]);
  } finally {
    closeDatabase(result);
  }
});

test("a second decision replaces the first, rather than raising a raw SQLite error or getting stuck", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await markDisputed(result.db, bookingId, contractId, "5000000");

    let txHash = "first-attempt-tx-hash";
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      resolveDispute: async () => ({ unsignedXdr: "x", txHash }),
    };

    const first = await resolveBookingDispute(result.db, bookingId, "refund-client", adapter);
    assert.equal(first.txHash, "first-attempt-tx-hash");
    const firstRecorded = await getEscrowDisputeResolution(result.db, bookingId);
    assert.equal(firstRecorded?.outcome, "refund-client");
    assert.equal(firstRecorded?.txHash, "first-attempt-tx-hash");

    // The first attempt's XDR was never signed (expired, or the wrong
    // outcome was chosen) -- a second, corrected attempt must replace it,
    // not be permanently blocked by it.
    txHash = "second-attempt-tx-hash";
    const second = await resolveBookingDispute(result.db, bookingId, "pay-provider", adapter);
    assert.equal(second.txHash, "second-attempt-tx-hash");
    const secondRecorded = await getEscrowDisputeResolution(result.db, bookingId);
    assert.equal(secondRecorded?.outcome, "pay-provider");
    assert.equal(secondRecorded?.txHash, "second-attempt-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("setBalanceState throws for an unknown booking id instead of silently writing nothing", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => setBalanceState(result.db, randomBookingId(), "paid_cash"), TypeError);
  } finally {
    closeDatabase(result);
  }
});
