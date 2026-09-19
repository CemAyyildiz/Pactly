/**
 * `payments/stellar.ts` exercised as a unit: every network stage
 * (`getAccount`, `sendTransaction`, `waitForTransaction`) is overridden, so
 * nothing here ever reaches a real Soroban RPC endpoint. Covers the I/O
 * matrix's "Amount conversion" row and the submit path's success/failure
 * branches (mirrors `chain-client.test.ts`'s own shape for `chain/
 * client.ts`).
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Asset, Keypair, Operation, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

import {
  buildBalancePaymentTransaction,
  defaultWaitForTransaction,
  smallestUnitToStellarAmount,
  submitBalancePaymentTransaction,
} from "../src/payments/stellar.js";
import { PaymentFailedError, PaymentUnavailableError } from "../src/payments/errors.js";

test("smallestUnitToStellarAmount converts an AD-7 integer string to Stellar's own decimal amount, exactly", () => {
  assert.equal(smallestUnitToStellarAmount("14000000000"), "1400.0000000");
  assert.equal(smallestUnitToStellarAmount("0"), "0.0000000");
  assert.equal(smallestUnitToStellarAmount("1"), "0.0000001");
});

test("smallestUnitToStellarAmount refuses a non-integer string", () => {
  assert.throws(() => smallestUnitToStellarAmount("14.5"), TypeError);
  assert.throws(() => smallestUnitToStellarAmount("-5"), TypeError);
  assert.throws(() => smallestUnitToStellarAmount("abc"), TypeError);
});

test("smallestUnitToStellarAmount accepts exactly Stellar's own int64 stroop maximum, and refuses one stroop more", () => {
  assert.equal(smallestUnitToStellarAmount("9223372036854775807"), "922337203685.4775807");
  assert.throws(() => smallestUnitToStellarAmount("9223372036854775808"), TypeError);
});

test("buildBalancePaymentTransaction builds a plain classic payment operation, never a Soroban invocation", async () => {
  const source = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();
  const getAccount = async (publicKey: string) => {
    assert.equal(publicKey, source);
    return new Account(publicKey, "5");
  };

  const result = await buildBalancePaymentTransaction(
    { sourceAddress: source, destinationAddress: destination, assetCode: "USDC", assetIssuer: issuer, amount: "14000000000" },
    { getAccount },
  );

  assert.ok(result.unsignedXdr.length > 0);
  assert.match(result.txHash, /^[0-9a-f]{64}$/);

  const tx = TransactionBuilder.fromXDR(result.unsignedXdr, "Test SDF Network ; September 2015") as Transaction;
  assert.equal(tx.operations.length, 1);
  const op = tx.operations[0] as Operation.Payment;
  assert.equal(op.type, "payment");
  assert.equal(op.destination, destination);
  assert.equal(op.amount, "1400.0000000");
  assert.ok(op.asset.equals(new Asset("USDC", issuer)));
});

test("buildBalancePaymentTransaction refuses a non-integer amount before ever loading the account", async () => {
  await assert.rejects(
    () =>
      buildBalancePaymentTransaction(
        {
          sourceAddress: Keypair.random().publicKey(),
          destinationAddress: Keypair.random().publicKey(),
          assetCode: "USDC",
          assetIssuer: Keypair.random().publicKey(),
          amount: "14.5",
        },
        {
          getAccount: async () => {
            throw new Error("getAccount should not have been called");
          },
        },
      ),
    TypeError,
  );
});

/** A real, decodable payment envelope for `submitBalancePaymentTransaction`
 * to relay -- its own hash is not under test here (that binding lives in
 * `services/booking.ts`), only the send/poll seam's own branching. */
function fakeSignedPaymentXdr(): string {
  const account = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: "Test SDF Network ; September 2015" })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

test("submitBalancePaymentTransaction returns the txHash once the ledger confirms SUCCESS", async () => {
  const result = await submitBalancePaymentTransaction(fakeSignedPaymentXdr(), {
    sendTransaction: async () => ({ status: "PENDING", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
    waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as rpc.Api.GetTransactionResponse,
  });
  assert.equal(result.txHash, "deadbeef");
});

test("submitBalancePaymentTransaction refuses PaymentFailedError once the ledger reports FAILED", async () => {
  await assert.rejects(
    () =>
      submitBalancePaymentTransaction(fakeSignedPaymentXdr(), {
        sendTransaction: async () => ({ status: "PENDING", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
        waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.FAILED }) as rpc.Api.GetTransactionResponse,
      }),
    PaymentFailedError,
  );
});

test("submitBalancePaymentTransaction refuses PaymentFailedError when the send itself is rejected before submission", async () => {
  await assert.rejects(
    () =>
      submitBalancePaymentTransaction(fakeSignedPaymentXdr(), {
        sendTransaction: async () => ({ status: "ERROR", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
        waitForTransaction: async () => {
          throw new Error("waitForTransaction should not have been called");
        },
      }),
    PaymentFailedError,
  );
});

test("submitBalancePaymentTransaction refuses PaymentUnavailableError when sendTransaction cannot reach the network", async () => {
  await assert.rejects(
    () =>
      submitBalancePaymentTransaction(fakeSignedPaymentXdr(), {
        sendTransaction: async () => {
          throw new Error("network unreachable");
        },
      }),
    PaymentUnavailableError,
  );
});

test("submitBalancePaymentTransaction refuses PaymentUnavailableError when polling never reaches a final status", async () => {
  await assert.rejects(
    () =>
      submitBalancePaymentTransaction(fakeSignedPaymentXdr(), {
        sendTransaction: async () => ({ status: "PENDING", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
        waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }) as rpc.Api.GetTransactionResponse,
      }),
    PaymentUnavailableError,
  );
});

test("submitBalancePaymentTransaction refuses PaymentUnavailableError (never PaymentFailedError) when the RPC endpoint asks to retry later", async () => {
  await assert.rejects(
    () =>
      submitBalancePaymentTransaction(fakeSignedPaymentXdr(), {
        sendTransaction: async () => ({ status: "TRY_AGAIN_LATER", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
        waitForTransaction: async () => {
          throw new Error("waitForTransaction should not have been called");
        },
      }),
    PaymentUnavailableError,
  );
});

// ---------------------------------------------------------------------------
// `defaultWaitForTransaction`: exported specifically so its own NOT_FOUND
// retry loop and timeout are testable in milliseconds, not the real ~5-minute
// ceiling `submitBalancePaymentTransaction` uses by default.
// ---------------------------------------------------------------------------

test("defaultWaitForTransaction retries past NOT_FOUND and returns the eventual SUCCESS", async () => {
  let calls = 0;
  const fakeServer = {
    getTransaction: async () => {
      calls += 1;
      if (calls < 3) {
        return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as rpc.Api.GetTransactionResponse;
      }
      return { status: rpc.Api.GetTransactionStatus.SUCCESS } as rpc.Api.GetTransactionResponse;
    },
  } as unknown as rpc.Server;

  const result = await defaultWaitForTransaction(fakeServer, "deadbeef", 5, 1);
  assert.equal(result.status, rpc.Api.GetTransactionStatus.SUCCESS);
  assert.equal(calls, 3);
});

test("defaultWaitForTransaction refuses PaymentUnavailableError once every attempt is spent still NOT_FOUND", async () => {
  let calls = 0;
  const fakeServer = {
    getTransaction: async () => {
      calls += 1;
      return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as rpc.Api.GetTransactionResponse;
    },
  } as unknown as rpc.Server;

  await assert.rejects(() => defaultWaitForTransaction(fakeServer, "deadbeef", 3, 1), PaymentUnavailableError);
  assert.equal(calls, 3, "must try exactly `attempts` times, never more, never fewer");
});
