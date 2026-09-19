/**
 * `services/booking.ts` exercised as a unit -- no network access anywhere
 * (the `simulate` stage is overridden and returns a simulation error, so
 * nothing past it ever runs). Covers `lockDeposit`'s argument wiring (a
 * reversed professional/client pair would lock a deposit payable to the
 * wrong party -- a real money-safety bug class this story had no test
 * for) and `setBalanceState`'s refusal to silently write nothing for an
 * unknown booking id.
 */
import "./testConfigEnv.js";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey, scValToNative, type rpc } from "@stellar/stellar-sdk";

import { lockDeposit, setBalanceState } from "../src/services/booking.js";
import { Account, type ChainCallDeps } from "../src/chain/client.js";
import { closeDatabase, openTestDatabase, randomBookingId, seedBooking, seedProviderProfile } from "./helpers.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function simulationError(message: string): rpc.Api.SimulateTransactionResponse {
  return {
    id: "1",
    latestLedger: 100,
    events: [],
    error: message,
    _parsed: true,
  } as rpc.Api.SimulateTransactionResponse;
}

test("lockDeposit submits create_booking with the professional's wallet as the professional, never the client's", async () => {
  const result = openTestDatabase();
  try {
    const clientKeypair = Keypair.random();
    const professionalWallet = Keypair.random().publicKey();
    const tokenAddress = fakeContractId();
    const depositAmount = "5000000";
    const cancelDeadline = Math.floor(Date.now() / 1000) + 3600;

    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientKeypair.publicKey(),
      tokenAddress,
      depositAmount,
      cancelDeadline,
    });

    let capturedArgs: unknown[] | undefined;
    const deps: Partial<ChainCallDeps> = {
      contractId: fakeContractId(),
      getAccount: async (publicKey) => new Account(publicKey, "100"),
      simulate: async (tx) => {
        const op = tx.operations[0];
        assert.equal(op?.type, "invokeHostFunction");
        if (op?.type === "invokeHostFunction" && op.func.type === "hostFunctionTypeInvokeContract") {
          capturedArgs = op.func.invokeContract.args.map((arg) => scValToNative(arg));
        }
        return simulationError("HostError: Error(Contract, #6)");
      },
      send: async () => {
        throw new Error("send should not be called after a simulation error");
      },
      waitForTransaction: async () => {
        throw new Error("waitForTransaction should not be called after a simulation error");
      },
    };

    await assert.rejects(() => lockDeposit(result.db, bookingId, clientKeypair, deps));

    assert.ok(capturedArgs, "simulate should have been called with the built transaction");
    const [bookingIdBytes, professional, client, token, amount, deadline] = capturedArgs as [
      Uint8Array,
      string,
      string,
      string,
      bigint,
      bigint,
    ];
    assert.equal(Buffer.from(bookingIdBytes).toString("hex"), bookingId);
    assert.equal(professional, professionalWallet, "professional must be the provider profile's wallet");
    assert.equal(client, clientKeypair.publicKey(), "client must be the booking's own client wallet");
    assert.notEqual(professional, client, "professional and client must not have been swapped");
    assert.equal(token, tokenAddress);
    assert.equal(amount.toString(), depositAmount);
    assert.equal(Number(deadline), cancelDeadline);
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
