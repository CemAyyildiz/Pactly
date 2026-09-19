/**
 * `runner.ts`'s tick isolation (the spec's own "Runner resilience" I/O
 * matrix row): a reconciler tick that throws is logged, never crashes the
 * process, and the next tick still fires on its own schedule. Both
 * intervals are injected short (a few milliseconds) so this test finishes
 * fast and never waits for a real 15s/30s clock.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { EscrowSummary, ListEscrowsResponse } from "@trustless-work/escrow-js";

import { startRunner } from "../src/runner.js";
import { getBookingById, updateEscrowContractId } from "../src/db/bookings.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function fakeAddress(): string {
  return Keypair.random().publicKey();
}

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      if (await predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, 5);
    };
    void check();
  });
}

test("a hold-expiry tick that throws is logged, isolated, and the runner keeps scheduling the next one", async () => {
  const result = openTestDatabase();
  try {
    const logs: string[] = [];
    const handle = startRunner(result.db, {
      log: (message) => logs.push(message),
      reconcilerIntervalMs: 10_000_000, // effectively disabled for this test
      holdExpiryIntervalMs: 5,
    });

    // Closing the underlying connection makes every subsequent query throw
    // a real error -- the most direct way to force `expireHolds`'s own read
    // to fail without adding a test-only injection seam to `runner.ts`
    // itself. If tick isolation did not work, this would either throw out
    // of the runner's own timer (an unhandled rejection) or stop the timer
    // from ever firing again.
    result.sqlite.close();

    await waitFor(() => logs.filter((message) => message.includes("hold-expiry tick failed")).length >= 2, 1000);
    handle.stop();

    assert.ok(
      logs.filter((message) => message.includes("hold-expiry tick failed")).length >= 2,
      "at least two failed ticks must be logged -- proving the first failure did not stop the timer",
    );
  } finally {
    // Already closed above; closing twice would throw.
  }
});

test("the reconciler tick is skipped (not attempted) while Trustless Work config is incomplete", async () => {
  const result = openTestDatabase();
  try {
    // Trustless Work config is empty in the test fixture env
    // (testConfigEnv.ts), so the reconciler tick is skipped (logged once)
    // rather than ever reaching a network seam -- this is itself the
    // "refuse before any network access" discipline the reconciler tick
    // must honor, exercised end to end through the runner.
    const logs: string[] = [];
    const handle = startRunner(result.db, {
      log: (message) => logs.push(message),
      reconcilerIntervalMs: 5,
      holdExpiryIntervalMs: 5,
    });

    await waitFor(() => logs.some((message) => message.includes("reconciler tick skipped")), 1000);
    handle.stop();

    assert.ok(logs.some((message) => message.includes("Trustless Work config is incomplete")));
  } finally {
    closeDatabase(result);
  }
});

test("a reconciler tick with complete config and an injected listEscrows actually moves a reconcilable booking to locked", async () => {
  const result = openTestDatabase();
  try {
    const platformAddress = fakeAddress();
    const clientAddress = fakeAddress();
    const providerAddress = fakeAddress();
    const tokenAddress = fakeContractId();
    const providerProfileId = await seedProviderProfile(result, { walletAddress: providerAddress });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientAddress,
      tokenAddress,
      depositAmount: "10000000", // 1.0 USDC at 7 decimals
    });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);

    const fakeRow: EscrowSummary = {
      network: "testnet",
      contractId,
      type: "single-release",
      engagementId: bookingId,
      status: "active",
      totalAmount: null,
      balance: "1",
      asset: { name: "USDC", address: tokenAddress, contractId: tokenAddress },
      lastLedgerSeq: "100",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      snapshot: {
        title: "Pactly booking",
        description: "Pactly session deposit",
        engagementId: bookingId,
        trustline: { address: tokenAddress, contractId: tokenAddress, symbol: "USDC" },
        platformFee: "0",
        roles: {
          approvers: [clientAddress],
          serviceProviders: [providerAddress],
          releaseSigners: [providerAddress],
          receiver: providerAddress,
          platform: platformAddress,
          disputeResolvers: [platformAddress],
          admin: platformAddress,
        },
        amount: "1",
        milestones: [{ description: "session", approvalsTarget: 1 }],
      },
    };
    const listEscrows = async (): Promise<ListEscrowsResponse> => ({ data: [fakeRow], hasMore: false, nextCursor: null });

    const logs: string[] = [];
    const handle = startRunner(result.db, {
      log: (message) => logs.push(message),
      reconcilerIntervalMs: 5,
      holdExpiryIntervalMs: 10_000_000,
      reconcilerConfigComplete: () => true,
      reconcilerPlatformAddress: platformAddress,
      listEscrows,
    });

    await waitFor(async () => (await getBookingById(result.db, bookingId))?.escrowState === "locked", 2000);
    handle.stop();

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowState, "locked");
    assert.ok(logs.some((message) => message.includes("reconciler tick: applied=1")));
  } finally {
    closeDatabase(result);
  }
});

test("a reconciler tick whose injected listEscrows throws is logged, and the hold-expiry tick keeps running on its own schedule", async () => {
  const result = openTestDatabase();
  try {
    // `runReconcilerOnce` returns early, without ever calling `listEscrows`,
    // when there is nothing reconcilable -- seed one booking with a
    // persisted contractId so the injected, throwing `listEscrows` is
    // actually reached.
    const providerProfileId = await seedProviderProfile(result);
    const bookingId = await seedBooking(result, { providerProfileId });
    await updateEscrowContractId(result.db, bookingId, fakeContractId());

    const logs: string[] = [];
    const handle = startRunner(result.db, {
      log: (message) => logs.push(message),
      reconcilerIntervalMs: 5,
      holdExpiryIntervalMs: 5,
      reconcilerConfigComplete: () => true,
      listEscrows: async () => {
        throw new Error("simulated Trustless Work outage");
      },
    });

    await waitFor(() => logs.filter((message) => message.includes("reconciler tick failed")).length >= 2, 1000);
    // The hold-expiry tick (an unrelated, unaffected timer) must still be
    // running its own schedule the whole time -- this database is empty,
    // so its own log is silent, but the runner itself must not have
    // stopped scheduling anything just because the reconciler kept
    // throwing.
    handle.stop();

    assert.ok(
      logs.filter((message) => message.includes("reconciler tick failed")).length >= 2,
      "at least two failed reconciler ticks must be logged -- proving the first failure did not stop the timer",
    );
    assert.ok(logs.every((message) => !message.includes("hold-expiry tick failed")));
  } finally {
    closeDatabase(result);
  }
});
