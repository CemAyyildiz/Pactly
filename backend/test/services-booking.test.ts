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
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { BookingEscrowStateError, fundDeposit, lockDeposit, resolveBookingDispute, setBalanceState } from "../src/services/booking.js";
import { getEscrowDisputeResolution } from "../src/db/escrowDisputeResolutions.js";
import { getBookingById, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
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

function unreachableEscrowAdapter(): EscrowAdapter {
  return {
    deploy: async () => {
      throw new Error("deploy should not have been called");
    },
    fund: async () => {
      throw new Error("fund should not have been called");
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
    assert.deepEqual(lockResult.deploy, deployResult);

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

test("lockDeposit refuses to redeploy once escrow_state is already set", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    updateEscrowStateSync(result.db, bookingId, "locked");

    await assert.rejects(() => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit may run again (overwriting the persisted contractId) while escrow_state is still null", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const firstContractId = fakeContractId();
    const secondContractId = fakeContractId();
    let calls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        calls += 1;
        return { contractId: calls === 1 ? firstContractId : secondContractId, unsignedXdr: "x", txHash: "h" };
      },
    };

    await lockDeposit(result.db, bookingId, adapter);
    const secondResult = await lockDeposit(result.db, bookingId, adapter);
    assert.equal(secondResult.contractId, secondContractId);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, secondContractId, "the later deploy's contractId must win");
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit targets exactly the persisted contractId, never a caller-supplied one", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const depositAmount = "5000000";
    const bookingId = await seedBooking(result, { clientWalletAddress: clientAddress, depositAmount });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);

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

test("fundDeposit refuses once escrow_state is already set", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await updateEscrowContractId(result.db, bookingId, fakeContractId());
    updateEscrowStateSync(result.db, bookingId, "locked");

    await assert.rejects(() => fundDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
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

test("resolveBookingDispute refuses a second decision for the same booking", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");

    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      resolveDispute: async () => ({ unsignedXdr: "x", txHash: "h" }),
    };

    await resolveBookingDispute(result.db, bookingId, "refund-client", adapter);
    await assert.rejects(() => resolveBookingDispute(result.db, bookingId, "refund-client", adapter), TypeError);
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
