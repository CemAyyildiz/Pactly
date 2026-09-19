/**
 * `services/booking.ts`'s Story 3.4 additions: the real AD-13 slot hold
 * (`holdSlot`), the owner check (`getBookingForClient`), the booking read
 * view (`getBookingView`), `submitSignedTransaction`, and the hold-expiry
 * double-sale detector (`expireHolds`). No network access anywhere --
 * `holdSlot`'s USDC resolution is injected, and `submitSignedTransaction`
 * is driven through a fake `EscrowAdapter`.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import {
  BookingNotFoundError,
  SlotTakenError,
  SlotUnavailableError,
  TooManyHoldsError,
  XdrMismatchError,
  expireHolds,
  getBookingForClient,
  getBookingView,
  holdSlot,
  submitSignedTransaction,
} from "../src/services/booking.js";
import { ProviderNotFoundError, computeDepositAmount } from "../src/services/profile.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { getBookingById, setEscrowFundTxHash, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC = { contractId: "CUSDCFAKECONTRACTID000000000000000000000000000000" };
const resolveUsdc = async () => FAKE_USDC;

/** Builds a real, decodable (but never actually submitted anywhere)
 * transaction envelope and its own hash -- `submitSignedTransaction` only
 * ever needs a signed envelope's *hash* to match a stored one; signing
 * never changes that hash, so an unsigned envelope's hash is exactly the
 * same value a signed copy of it would have. This is enough to exercise
 * the match/mismatch logic without a real wallet signature. */
function buildFakeTransactionXdr(): { xdr: string; hash: string } {
  const account = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
    .setTimeout(30)
    .build();
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
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

test("holdSlot derives every amount from the provider's own profile, never from the caller", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, {
      isApproved: true,
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
    });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clientAddress, slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    const expectedDeposit = computeDepositAmount("10000000", 2000);
    assert.equal(hold.deposit.amount, expectedDeposit);
    assert.equal(hold.balance.amount, (BigInt("10000000") - BigInt(expectedDeposit)).toString());
    assert.equal(hold.price.amount, "10000000");
    assert.equal(hold.cancelDeadline, slotStartsAt - 24 * 3600);
    assert.equal(hold.holdExpiresAt, now + 600);
    assert.equal(hold.provider.id, providerProfileId);

    const booking = await getBookingForClient(result.db, hold.bookingId, clientAddress);
    assert.equal(booking.tokenAddress, FAKE_USDC.contractId);
    assert.equal(booking.depositAmount, expectedDeposit);
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot refuses for an unapproved provider", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: false });
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 3600], now);

    await assert.rejects(
      () =>
        holdSlot(
          result.db,
          { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: now + 3600 },
          { now, resolveUsdcAsset: resolveUsdc },
        ),
      ProviderNotFoundError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot refuses for a slot in the past or one the provider never published", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    await replaceFutureSlots(result.db, providerProfileId, [now + 3600], now);

    await assert.rejects(
      () =>
        holdSlot(
          result.db,
          { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: now - 3600 },
          { now, resolveUsdcAsset: resolveUsdc },
        ),
      SlotUnavailableError,
    );
    await assert.rejects(
      () =>
        holdSlot(
          result.db,
          { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: now + 7200 },
          { now, resolveUsdcAsset: resolveUsdc },
        ),
      SlotUnavailableError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: a concurrent second hold for the same slot gets SLOT_TAKEN with the day's other open slots", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    const otherSlotSameDay = now + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt, otherSlotSameDay], now);

    const first = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    assert.ok(first.bookingId);

    await assert.rejects(
      () =>
        holdSlot(
          result.db,
          { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
          { now, resolveUsdcAsset: resolveUsdc },
        ),
      (error: unknown) => {
        assert.ok(error instanceof SlotTakenError);
        assert.deepEqual(error.sameDaySlots, [otherSlotSameDay]);
        return true;
      },
    );
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: two truly concurrent holds for the same slot -- exactly one succeeds", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    const attempt = () =>
      holdSlot(
        result.db,
        { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
        { now, resolveUsdcAsset: resolveUsdc },
      );

    const outcomes = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one hold must succeed");
    assert.equal(rejected.length, 1, "exactly one hold must be refused");
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof SlotTakenError);
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: a locked booking keeps its slot even after its own original hold_expires_at has passed", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 200_000; // far enough out that it is still a valid future slot later in this test
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    const locked = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    await updateEscrowContractId(result.db, locked.bookingId, "CFAKECONTRACT000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, locked.bookingId, "locked");

    // Well past the original 10-minute hold window, but still before the
    // slot itself starts -- the booking is locked now, so the hold's own
    // clock is moot.
    const wayAfterOriginalHold = now + 5000;
    await assert.rejects(
      () =>
        holdSlot(
          result.db,
          { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
          { now: wayAfterOriginalHold, resolveUsdcAsset: resolveUsdc },
        ),
      SlotTakenError,
    );

    const { listOpenFutureSlots } = await import("../src/db/availabilitySlots.js");
    const open = await listOpenFutureSlots(result.db, providerProfileId, { now: wayAfterOriginalHold });
    assert.deepEqual(open, []);
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: once a hold expires, the slot can be held again", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    const first = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    const afterExpiry = now + 700; // past the 600-second hold
    const second = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now: afterExpiry, resolveUsdcAsset: resolveUsdc },
    );
    assert.notEqual(second.bookingId, first.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: the same wallet asking again for a slot it already actively holds gets the same booking back, not SLOT_TAKEN", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const clientWalletAddress = Keypair.random().publicKey();

    const first = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, { now, resolveUsdcAsset: resolveUsdc });
    const second = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, { now: now + 5, resolveUsdcAsset: resolveUsdc });

    assert.equal(second.bookingId, first.bookingId);
    assert.equal(second.holdExpiresAt, first.holdExpiresAt);
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: a different wallet still gets SLOT_TAKEN even though the first wallet's own re-hold would not", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    await holdSlot(result.db, { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt }, { now, resolveUsdcAsset: resolveUsdc });

    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt }, { now, resolveUsdcAsset: resolveUsdc }),
      SlotTakenError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: a wallet with 3 pending holds already open gets 429-mapped TooManyHoldsError on a 4th", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots, now);
    const clientWalletAddress = Keypair.random().publicKey();

    for (const slotStartsAt of slots.slice(0, 3)) {
      await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, { now, resolveUsdcAsset: resolveUsdc });
    }

    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: sameDaySlots uses the caller's own local day when tzOffsetMinutes is supplied, not the UTC day", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    // UTC+3 (JS convention: tzOffsetMinutes is minutes to ADD to local time
    // to reach UTC, so UTC+3 is -180). Local midnight for UTC+3 falls at
    // UTC 21:00 the previous day -- a slot at UTC 22:00 and one at UTC
    // 01:00 the *next* UTC calendar day are both still the same UTC+3
    // local day, even though they fall on two different UTC dates. This
    // is exactly the case a plain UTC-day grouping gets wrong.
    const tzOffsetMinutes = -180;
    const utcDayStart = 950_400; // an arbitrary UTC day boundary
    const now = utcDayStart + 20 * 3600; // 20:00 UTC, before either slot
    const slotStartsAt = utcDayStart + 22 * 3600; // 22:00 UTC (day D) -- UTC+3 local day D+1
    const otherSlotNextUtcDaySameLocalDay = utcDayStart + 25 * 3600; // 01:00 UTC (day D+1) -- still UTC+3 local day D+1
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt, otherSlotNextUtcDaySameLocalDay], now);

    await holdSlot(result.db, { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt }, { now, resolveUsdcAsset: resolveUsdc });

    // Without tzOffsetMinutes (UTC grouping), the other slot -- a different
    // UTC calendar date -- would not appear here at all.
    await assert.rejects(
      () =>
        holdSlot(
          result.db,
          { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
          { now, resolveUsdcAsset: resolveUsdc },
        ),
      (error: unknown) => {
        assert.ok(error instanceof SlotTakenError);
        assert.deepEqual(error.sameDaySlots, []);
        return true;
      },
    );

    // With tzOffsetMinutes for UTC+3, the two slots share a local day.
    await assert.rejects(
      () =>
        holdSlot(
          result.db,
          { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt, tzOffsetMinutes },
          { now, resolveUsdcAsset: resolveUsdc },
        ),
      (error: unknown) => {
        assert.ok(error instanceof SlotTakenError);
        assert.deepEqual(error.sameDaySlots, [otherSlotNextUtcDaySameLocalDay]);
        return true;
      },
    );
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: freeCancellationEnded is true in the response once cancelDeadline has already passed but the slot is still in the future", async () => {
  const result = openTestDatabase();
  try {
    // A 1-hour free-cancellation window: cancelDeadline = slotStartsAt - 3600.
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, cancellationWindowHours: 1 });
    const now = 1_000_000;
    const slotStartsAt = now + 1800; // 30 minutes from now -- still bookable
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    // cancelDeadline = slotStartsAt - 3600 = now - 1800, already in the past
    // relative to `now`, even though the slot itself has not started yet.
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    assert.equal(hold.cancelDeadline, now - 1800);
    assert.equal(hold.freeCancellationEnded, true);
  } finally {
    closeDatabase(result);
  }
});

test("holdSlot: freeCancellationEnded is omitted when the free-cancellation window has not passed yet", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, cancellationWindowHours: 1 });
    const now = 1_000_000;
    const slotStartsAt = now + 7200; // 2 hours out -- well before the 1h deadline
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    assert.equal(hold.freeCancellationEnded, undefined);
  } finally {
    closeDatabase(result);
  }
});

test("getBookingForClient throws BookingNotFoundError for an unknown id and for someone else's booking", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const clientAddress = Keypair.random().publicKey();
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clientAddress, slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    await assert.rejects(() => getBookingForClient(result.db, "does-not-exist", clientAddress), BookingNotFoundError);
    await assert.rejects(
      () => getBookingForClient(result.db, hold.bookingId, Keypair.random().publicKey()),
      BookingNotFoundError,
    );
    const owned = await getBookingForClient(result.db, hold.bookingId, clientAddress);
    assert.equal(owned.id, hold.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("getBookingView reports escrowState only from the persisted column, plus the derived lifecycle", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, priceAmount: "10000000", depositRateBps: 2000 });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const clientAddress = Keypair.random().publicKey();
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clientAddress, slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    const beforeLock = await getBookingView(result.db, hold.bookingId, clientAddress);
    assert.equal(beforeLock.escrowState, null);
    assert.equal(beforeLock.slotStartsAt, slotStartsAt);
    assert.equal(beforeLock.deposit.amount, hold.deposit.amount);

    await updateEscrowContractId(result.db, hold.bookingId, "CFAKECONTRACT000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, hold.bookingId, "locked");
    const afterLock = await getBookingView(result.db, hold.bookingId, clientAddress);
    assert.equal(afterLock.escrowState, "locked");
    assert.equal(afterLock.contractId, "CFAKECONTRACT000000000000000000000000000000000000");
  } finally {
    closeDatabase(result);
  }
});

test("submitSignedTransaction relays a signed envelope whose hash matches the stored deploy txHash, and records the submission", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    const { xdr, hash } = buildFakeTransactionXdr();
    const contractId = "CFAKECONTRACT000000000000000000000000000000000000";
    await updateEscrowContractId(result.db, hold.bookingId, contractId, "unsigned-deploy-xdr", hash);

    let captured: string | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      submit: async (signedXdr) => {
        captured = signedXdr;
        return { txHash: "submitted-tx-hash" };
      },
    };
    const outcome = await submitSignedTransaction(result.db, hold.bookingId, xdr, "client", adapter, now);
    assert.equal(outcome.txHash, "submitted-tx-hash");
    assert.equal(captured, xdr);

    const booking = await getBookingById(result.db, hold.bookingId);
    assert.equal(booking?.deploySubmittedAt, now, "a matching deploy submit must be recorded");
    assert.equal(booking?.holdExpiresAt, now + 600, "the hold must be extended ten minutes from the submission");
  } finally {
    closeDatabase(result);
  }
});

test("submitSignedTransaction relays a signed envelope whose hash matches the stored fund txHash, without touching deploySubmittedAt again", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    const deployTx = buildFakeTransactionXdr();
    const contractId = "CFAKECONTRACT000000000000000000000000000000000000";
    await updateEscrowContractId(result.db, hold.bookingId, contractId, "unsigned-deploy-xdr", deployTx.hash);
    await submitSignedTransaction(result.db, hold.bookingId, deployTx.xdr, "client", { ...unreachableEscrowAdapter(), submit: async () => ({ txHash: "deploy-landed" }) }, now);

    const fundTx = buildFakeTransactionXdr();
    await setEscrowFundTxHash(result.db, hold.bookingId, fundTx.hash);

    let submitCount = 0;
    const outcome = await submitSignedTransaction(
      result.db,
      hold.bookingId,
      fundTx.xdr,
      "client",
      { ...unreachableEscrowAdapter(), submit: async () => { submitCount += 1; return { txHash: "fund-landed" }; } },
      now + 5,
    );
    assert.equal(outcome.txHash, "fund-landed");
    assert.equal(submitCount, 1);

    const booking = await getBookingById(result.db, hold.bookingId);
    assert.equal(booking?.holdExpiresAt, now + 600, "a fund match must not re-extend the hold a second time");
  } finally {
    closeDatabase(result);
  }
});

test("submitSignedTransaction refuses (XdrMismatchError) a signed envelope that matches neither stored hash, before ever calling the adapter", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    const storedTx = buildFakeTransactionXdr();
    await updateEscrowContractId(result.db, hold.bookingId, "CFAKECONTRACT000000000000000000000000000000000000", "unsigned-deploy-xdr", storedTx.hash);

    const strangersTx = buildFakeTransactionXdr();
    await assert.rejects(
      () => submitSignedTransaction(result.db, hold.bookingId, strangersTx.xdr, "client", unreachableEscrowAdapter(), now),
      XdrMismatchError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("submitSignedTransaction refuses (XdrMismatchError) an envelope that does not decode as a transaction at all", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    await assert.rejects(
      () => submitSignedTransaction(result.db, hold.bookingId, "not-a-real-xdr-blob", "client", unreachableEscrowAdapter(), now),
      XdrMismatchError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("expireHolds logs an anomaly only for an expired, unconfirmed hold whose slot has since been re-held", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    const first = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    // A deploy was submitted before the hold expired -- a contractId is
    // persisted, but escrow_state is still null.
    await updateEscrowContractId(result.db, first.bookingId, "CFAKECONTRACT000000000000000000000000000000000000");

    const afterExpiry = now + 700;
    const messagesBeforeRebooking: string[] = [];
    expireHolds(result.db, afterExpiry, (message) => messagesBeforeRebooking.push(message));
    assert.equal(messagesBeforeRebooking.length, 0, "no anomaly until the slot is actually re-held by someone else");

    // The slot is re-held by a second client.
    await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now: afterExpiry, resolveUsdcAsset: resolveUsdc },
    );

    const messagesAfterRebooking: string[] = [];
    const count = expireHolds(result.db, afterExpiry, (message) => messagesAfterRebooking.push(message));
    assert.equal(count, 1);
    assert.match(messagesAfterRebooking[0]!, /double-sale/);
    assert.match(messagesAfterRebooking[0]!, new RegExp(first.bookingId));
  } finally {
    closeDatabase(result);
  }
});

test("expireHolds also catches two bookings sharing one slot where one is locked and the other is locked or actively held, logging each pair once per process", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slotStartsAt = now + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);

    const bookingA = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      { now, resolveUsdcAsset: resolveUsdc },
    );
    await updateEscrowContractId(result.db, bookingA.bookingId, "CCONFLICTA00000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, bookingA.bookingId, "locked");
    const bookingARow = await getBookingById(result.db, bookingA.bookingId);
    assert.ok(bookingARow?.slotId);

    // This should be impossible via holdSlot's own atomic guarantee -- a
    // second booking is inserted directly (bypassing the guard) onto the
    // very same slot, also locked, simulating the safety-net scenario the
    // detector exists for.
    const { insertBooking, updateEscrowContractId: setContractId } = await import("../src/db/bookings.js");
    const bookingBId = "b".repeat(32);
    await insertBooking(result.db, {
      id: bookingBId,
      providerProfileId,
      clientWalletAddress: Keypair.random().publicKey(),
      tokenAddress: FAKE_USDC.contractId,
      depositAmount: "1",
      cancelDeadline: now + 3600,
      slotId: bookingARow!.slotId!,
      holdExpiresAt: now + 600,
      createdAt: Date.now(),
    });
    await setContractId(result.db, bookingBId, "CCONFLICTB00000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, bookingBId, "locked");

    const messages: string[] = [];
    const count = expireHolds(result.db, now, (message) => messages.push(message));
    assert.ok(count >= 1);
    assert.ok(messages.some((message) => /conflicting bookings/.test(message)));

    // Logged only once even across repeated ticks.
    const secondTickMessages: string[] = [];
    expireHolds(result.db, now, (message) => secondTickMessages.push(message));
    assert.ok(!secondTickMessages.some((message) => /conflicting bookings/.test(message)), "the same conflict pair must not be logged twice");
  } finally {
    closeDatabase(result);
  }
});
