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
import { Keypair } from "@stellar/stellar-sdk";

import {
  BookingNotFoundError,
  SlotTakenError,
  SlotUnavailableError,
  expireHolds,
  getBookingForClient,
  getBookingView,
  holdSlot,
  submitSignedTransaction,
} from "../src/services/booking.js";
import { ProviderNotFoundError, computeDepositAmount } from "../src/services/profile.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC = { contractId: "CUSDCFAKECONTRACTID000000000000000000000000000000" };
const resolveUsdc = async () => FAKE_USDC;

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

test("submitSignedTransaction relays to the adapter's submit and returns its txHash", async () => {
  const result = openTestDatabase();
  try {
    let captured: string | undefined;
    const adapter: EscrowAdapter = {
      deploy: () => {
        throw new Error("not used");
      },
      fund: () => {
        throw new Error("not used");
      },
      approve: () => {
        throw new Error("not used");
      },
      release: () => {
        throw new Error("not used");
      },
      startDispute: () => {
        throw new Error("not used");
      },
      resolveDispute: () => {
        throw new Error("not used");
      },
      submit: async (signedXdr) => {
        captured = signedXdr;
        return { txHash: "submitted-tx-hash" };
      },
    };
    const outcome = await submitSignedTransaction("some-booking-id", "signed-xdr-blob", adapter);
    assert.equal(outcome.txHash, "submitted-tx-hash");
    assert.equal(captured, "signed-xdr-blob");
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
