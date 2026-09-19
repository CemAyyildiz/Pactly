/**
 * Story 3.7's own additions to `services/booking.ts` -- `buildBalancePayment`,
 * `submitBalancePayment` and `markBalancePaidCash`. No network access
 * anywhere: `buildBalancePayment`'s own USDC/account seams and
 * `submitBalancePayment`'s own send/poll seam are both injected. Covers this
 * story's own I/O matrix rows: role-correct ownership (a wrong caller gets
 * `BookingNotFoundError`), the locked/unpaid/before-the-session guard, the
 * zero-balance refusal, the submit-binding hash check, and every terminal
 * outcome (`paid_platform`, `paid_cash`, `PAYMENT_FAILED`,
 * `PAYMENT_UNAVAILABLE`).
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

import {
  BookingEscrowStateError,
  BookingNotFoundError,
  NothingToPayError,
  XdrMismatchError,
  buildBalancePayment,
  markBalancePaidCash,
  submitBalancePayment,
} from "../src/services/booking.js";
import { insertBooking, getBookingById, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { availabilitySlots } from "../src/db/schema.js";
import { PaymentFailedError, PaymentUnavailableError } from "../src/payments/errors.js";
import type { SubmitBalancePaymentResult } from "../src/payments/stellar.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";

const FAKE_USDC = { code: "USDC", issuer: Keypair.random().publicKey(), contractId: "CFAKEUSDC0000000000000000000000000000000000000000" };
const resolveUsdc = async () => FAKE_USDC;

function fakeContractId(): string {
  return "CFAKECONTRACT0000000000000000000000000000000000000";
}

async function seedLockedBookingWithBalance(
  result: Awaited<ReturnType<typeof openTestDatabase>>,
  options: {
    clientWalletAddress?: string;
    providerWalletAddress?: string;
    balanceAmount?: string;
    cancelDeadline?: number;
  } = {},
): Promise<{ bookingId: string; clientWalletAddress: string; providerWalletAddress: string }> {
  const clientWalletAddress = options.clientWalletAddress ?? Keypair.random().publicKey();
  const providerWalletAddress = options.providerWalletAddress ?? Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
  const bookingId = await seedBooking(result, {
    providerProfileId,
    clientWalletAddress,
    balanceAmount: options.balanceAmount ?? "14000000000",
    cancelDeadline: options.cancelDeadline ?? Math.floor(Date.now() / 1000) + 3600,
  });
  await updateEscrowContractId(result.db, bookingId, fakeContractId());
  updateEscrowStateSync(result.db, bookingId, "locked");
  return { bookingId, clientWalletAddress, providerWalletAddress };
}

const getAccountStub = async (publicKey: string) => new Account(publicKey, "0");

test("buildBalancePayment builds an unsigned payment for the client's own locked, unpaid booking", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBookingWithBalance(result);
    const built = await buildBalancePayment(result.db, bookingId, clientWalletAddress, {
      resolveUsdcAsset: resolveUsdc,
      getAccount: getAccountStub,
    });
    assert.ok(built.unsignedXdr.length > 0);
    const row = await getBookingById(result.db, bookingId);
    assert.ok(row?.balancePaymentBuiltHash);
    assert.equal(row?.balanceState, "unpaid");
  } finally {
    closeDatabase(result);
  }
});

test("buildBalancePayment gives BookingNotFoundError for anyone but the booking's own client", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await seedLockedBookingWithBalance(result);
    await assert.rejects(
      () =>
        buildBalancePayment(result.db, bookingId, Keypair.random().publicKey(), {
          resolveUsdcAsset: resolveUsdc,
          getAccount: getAccountStub,
        }),
      BookingNotFoundError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("buildBalancePayment refuses BookingEscrowStateError when the booking is not locked", async () => {
  const result = openTestDatabase();
  try {
    const clientWalletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result);
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress, balanceAmount: "14000000000" });
    // Never locked -- escrowState stays null.
    await assert.rejects(
      () => buildBalancePayment(result.db, bookingId, clientWalletAddress, { resolveUsdcAsset: resolveUsdc, getAccount: getAccountStub }),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("buildBalancePayment refuses BookingEscrowStateError once the balance is already paid", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress, providerWalletAddress } = await seedLockedBookingWithBalance(result);
    await markBalancePaidCash(result.db, bookingId, providerWalletAddress);
    await assert.rejects(
      () => buildBalancePayment(result.db, bookingId, clientWalletAddress, { resolveUsdcAsset: resolveUsdc, getAccount: getAccountStub }),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("buildBalancePayment refuses BookingEscrowStateError once the appointment has already started", async () => {
  const result = openTestDatabase();
  try {
    const providerWalletAddress = Keypair.random().publicKey();
    const clientWalletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
    const now = Math.floor(Date.now() / 1000);
    // Seed a booking whose slot already started -- via replaceFutureSlots +
    // holdSlot would refuse a past slot outright, so this seeds the slot
    // and booking rows directly instead, the same way `seedBooking`'s own
    // helper does for every other pre-3.4-shaped fixture.
    const slotId = "slot-already-started";
    await result.db.insert(availabilitySlots).values({ id: slotId, providerProfileId, startsAt: now - 3600, createdAt: Date.now() });
    const bookingId = "b".repeat(32);
    await insertBooking(result.db, {
      id: bookingId,
      providerProfileId,
      clientWalletAddress,
      tokenAddress: "CFAKETOKEN000000000000000000000000000000000000000",
      depositAmount: "1000000",
      balanceAmount: "14000000000",
      cancelDeadline: now - 7200,
      slotId,
      createdAt: Date.now(),
    });
    await updateEscrowContractId(result.db, bookingId, fakeContractId());
    updateEscrowStateSync(result.db, bookingId, "locked");

    await assert.rejects(
      () =>
        buildBalancePayment(result.db, bookingId, clientWalletAddress, { now, resolveUsdcAsset: resolveUsdc, getAccount: getAccountStub }),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("buildBalancePayment refuses NothingToPayError when the balance is zero", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBookingWithBalance(result, { balanceAmount: "0" });
    await assert.rejects(
      () => buildBalancePayment(result.db, bookingId, clientWalletAddress, { resolveUsdcAsset: resolveUsdc, getAccount: getAccountStub }),
      NothingToPayError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("submitBalancePayment refuses XdrMismatchError for a signed envelope that does not match the built hash", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBookingWithBalance(result);
    await buildBalancePayment(result.db, bookingId, clientWalletAddress, { resolveUsdcAsset: resolveUsdc, getAccount: getAccountStub });

    // A syntactically valid but unrelated signed transaction -- its hash
    // will never match the stored balancePaymentBuiltHash.
    const account = new Account(Keypair.random().publicKey(), "0");
    const unrelatedTx = new TransactionBuilder(account, { fee: "100", networkPassphrase: "Test SDF Network ; September 2015" })
      .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
      .setTimeout(30)
      .build();

    await assert.rejects(
      () => submitBalancePayment(result.db, bookingId, clientWalletAddress, unrelatedTx.toXDR(), {}),
      XdrMismatchError,
    );
    const row = await getBookingById(result.db, bookingId);
    assert.equal(row?.balanceState, "unpaid");
  } finally {
    closeDatabase(result);
  }
});

test("submitBalancePayment marks paid_platform and stores the tx hash once the ledger confirms SUCCESS", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBookingWithBalance(result);
    const built = await buildBalancePayment(result.db, bookingId, clientWalletAddress, {
      resolveUsdcAsset: resolveUsdc,
      getAccount: getAccountStub,
    });

    const submitted = await submitBalancePayment(result.db, bookingId, clientWalletAddress, built.unsignedXdr, {
      sendTransaction: async () => ({ status: "PENDING", hash: "cafef00d" }) as rpc.Api.SendTransactionResponse,
      waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as rpc.Api.GetTransactionResponse,
    });
    const expected: SubmitBalancePaymentResult = { txHash: "cafef00d" };
    assert.deepEqual(submitted, expected);

    const row = await getBookingById(result.db, bookingId);
    assert.equal(row?.balanceState, "paid_platform");
    assert.equal(row?.balancePaymentTxHash, "cafef00d");
  } finally {
    closeDatabase(result);
  }
});

test("submitBalancePayment surfaces PaymentFailedError and never writes balance_state once the ledger reports FAILED", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBookingWithBalance(result);
    const built = await buildBalancePayment(result.db, bookingId, clientWalletAddress, {
      resolveUsdcAsset: resolveUsdc,
      getAccount: getAccountStub,
    });

    await assert.rejects(
      () =>
        submitBalancePayment(result.db, bookingId, clientWalletAddress, built.unsignedXdr, {
          sendTransaction: async () => ({ status: "PENDING", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
          waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.FAILED }) as rpc.Api.GetTransactionResponse,
        }),
      PaymentFailedError,
    );
    const row = await getBookingById(result.db, bookingId);
    assert.equal(row?.balanceState, "unpaid");
  } finally {
    closeDatabase(result);
  }
});

test("submitBalancePayment surfaces PaymentUnavailableError when the RPC endpoint is unreachable", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBookingWithBalance(result);
    const built = await buildBalancePayment(result.db, bookingId, clientWalletAddress, {
      resolveUsdcAsset: resolveUsdc,
      getAccount: getAccountStub,
    });

    await assert.rejects(
      () =>
        submitBalancePayment(result.db, bookingId, clientWalletAddress, built.unsignedXdr, {
          sendTransaction: async () => {
            throw new Error("network unreachable");
          },
        }),
      PaymentUnavailableError,
    );
    const row = await getBookingById(result.db, bookingId);
    assert.equal(row?.balanceState, "unpaid");
  } finally {
    closeDatabase(result);
  }
});

test("markBalancePaidCash writes paid_cash for the booking's own provider", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seedLockedBookingWithBalance(result);
    await markBalancePaidCash(result.db, bookingId, providerWalletAddress);
    const row = await getBookingById(result.db, bookingId);
    assert.equal(row?.balanceState, "paid_cash");
    assert.equal(row?.balancePaymentTxHash, null);
  } finally {
    closeDatabase(result);
  }
});

test("markBalancePaidCash gives BookingNotFoundError when the client calls it", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedLockedBookingWithBalance(result);
    await assert.rejects(() => markBalancePaidCash(result.db, bookingId, clientWalletAddress), BookingNotFoundError);
  } finally {
    closeDatabase(result);
  }
});

test("markBalancePaidCash refuses BookingEscrowStateError once the balance is already paid", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seedLockedBookingWithBalance(result);
    await markBalancePaidCash(result.db, bookingId, providerWalletAddress);
    await assert.rejects(() => markBalancePaidCash(result.db, bookingId, providerWalletAddress), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});
