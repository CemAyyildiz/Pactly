/**
 * `chain/client.ts` exercised as a unit: every network stage
 * (`getAccount`, `simulate`, `send`, `waitForTransaction`) is overridden via
 * `ChainCallDeps`, so nothing here ever reaches the Soroban RPC or the
 * network. Covers the I/O-matrix rows exercised through the client, not
 * only through `errors.ts`'s pure helpers ("contract error translated",
 * "contract call with no contract id"), plus the client's full success path
 * and its two post-simulation failure branches.
 */
import "./testConfigEnv.js";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { StrKey, rpc, xdr, SorobanDataBuilder } from "@stellar/stellar-sdk";

import {
  Account,
  Keypair,
  release,
  cancelByProfessional,
  createBooking,
  type ChainCallDeps,
  type CreateBookingArgs,
} from "../src/chain/client.js";
import { ChainConfigError, ChainContractError, ChainRequestError } from "../src/chain/errors.js";
import { randomBookingId } from "./helpers.js";

/** A syntactically valid contract StrKey (correct checksum) that names no
 * real, deployed contract -- enough for `new Contract(...)` inside
 * `invoke()` to accept it without ever reaching the network. */
function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

/** Every network stage throws if called -- so a test using this fails
 * loudly if the code under test does not refuse (or does not stop) before
 * reaching it, instead of silently passing. */
function unreachableStages(): Pick<ChainCallDeps, "getAccount" | "simulate" | "send" | "waitForTransaction"> {
  return {
    getAccount: async () => {
      throw new Error("network stage getAccount should not have been called");
    },
    simulate: async () => {
      throw new Error("network stage simulate should not have been called");
    },
    send: async () => {
      throw new Error("network stage send should not have been called");
    },
    waitForTransaction: async () => {
      throw new Error("network stage waitForTransaction should not have been called");
    },
  };
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

/** A minimal but real simulation success: `assembleTransaction` (called
 * inside `invoke`) needs a genuine `SorobanDataBuilder` (for its
 * `.build()`) and a `result.auth`/`result.retval`, not just any object
 * shape -- everything else about it is irrelevant to a test that never
 * actually submits to a network. */
function simulationSuccess(): rpc.Api.SimulateTransactionResponse {
  return {
    id: "1",
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: "100",
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  } as rpc.Api.SimulateTransactionResponse;
}

test("a contract call with ESCROW_CONTRACT_ID empty refuses before any network access", async () => {
  const signer = Keypair.random();
  await assert.rejects(
    () =>
      release(randomBookingId(), signer, {
        contractId: "",
        ...unreachableStages(),
      }),
    ChainConfigError,
  );
});

test("a contract call still refuses first even when overrides supply a real-looking contract id alongside an empty one", async () => {
  // contractId: "" must win regardless of what the network stages would
  // have done -- this is the same assertion as above, phrased against the
  // literal I/O-matrix wording ("the client refuses before reaching the
  // network, naming the setup step").
  const signer = Keypair.random();
  await assert.rejects(() => release(randomBookingId(), signer, { contractId: "", ...unreachableStages() }), (error: unknown) => {
    assert.ok(error instanceof ChainConfigError);
    assert.match(error.message, /ESCROW_CONTRACT_ID/);
    return true;
  });
});

test("a simulation returning a known contract error code throws ChainContractError with the right condition, through the client", async () => {
  const signer = Keypair.random();
  const contractId = fakeContractId();
  let sendCalled = false;
  let waitCalled = false;

  const deps: Partial<ChainCallDeps> = {
    contractId,
    getAccount: async (publicKey) => new Account(publicKey, "100"),
    simulate: async () => simulationError("HostError: Error(Contract, #6)\n\nEvent log (newest first):\n   0: ..."),
    send: async () => {
      sendCalled = true;
      throw new Error("send should not be called after a simulation error");
    },
    waitForTransaction: async () => {
      waitCalled = true;
      throw new Error("waitForTransaction should not be called after a simulation error");
    },
  };

  await assert.rejects(() => release(randomBookingId(), signer, deps), (error: unknown) => {
    assert.ok(error instanceof ChainContractError);
    assert.equal(error.condition, "InvalidState");
    return true;
  });
  assert.equal(sendCalled, false);
  assert.equal(waitCalled, false);
});

test("a second exported call (cancelByProfessional) also translates a simulation error through the client", async () => {
  const signer = Keypair.random();
  const contractId = fakeContractId();

  const deps: Partial<ChainCallDeps> = {
    contractId,
    getAccount: async (publicKey) => new Account(publicKey, "100"),
    simulate: async () => simulationError("HostError: Error(Contract, #9)\n\nEvent log (newest first):\n   0: ..."),
    send: async () => {
      throw new Error("send should not be called after a simulation error");
    },
    waitForTransaction: async () => {
      throw new Error("waitForTransaction should not be called after a simulation error");
    },
  };

  await assert.rejects(() => cancelByProfessional(randomBookingId(), signer, deps), (error: unknown) => {
    assert.ok(error instanceof ChainContractError);
    assert.equal(error.condition, "TooEarly");
    return true;
  });
});

test("the full success path (simulate, sign, send, wait) resolves with the submitted hash", async () => {
  const signer = Keypair.random();
  const contractId = fakeContractId();
  const hash = "ab".repeat(32);

  const deps: Partial<ChainCallDeps> = {
    contractId,
    getAccount: async (publicKey) => new Account(publicKey, "100"),
    simulate: async () => simulationSuccess(),
    send: async () => ({ status: "PENDING", hash }) as rpc.Api.SendTransactionResponse,
    waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as rpc.Api.GetTransactionResponse,
  };

  const result = await release(randomBookingId(), signer, deps);
  assert.equal(result.hash, hash);
});

test("a send status that is neither PENDING nor DUPLICATE throws ChainRequestError, and waitForTransaction is never reached", async () => {
  const signer = Keypair.random();
  const contractId = fakeContractId();
  let waitCalled = false;

  const deps: Partial<ChainCallDeps> = {
    contractId,
    getAccount: async (publicKey) => new Account(publicKey, "100"),
    simulate: async () => simulationSuccess(),
    send: async () => ({ status: "ERROR", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
    waitForTransaction: async () => {
      waitCalled = true;
      throw new Error("waitForTransaction should not be called after a rejected send");
    },
  };

  await assert.rejects(() => release(randomBookingId(), signer, deps), ChainRequestError);
  assert.equal(waitCalled, false);
});

test("a final transaction status of FAILED throws ChainRequestError", async () => {
  const signer = Keypair.random();
  const contractId = fakeContractId();

  const deps: Partial<ChainCallDeps> = {
    contractId,
    getAccount: async (publicKey) => new Account(publicKey, "100"),
    simulate: async () => simulationSuccess(),
    send: async () => ({ status: "PENDING", hash: "deadbeef" }) as rpc.Api.SendTransactionResponse,
    waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.FAILED }) as rpc.Api.GetTransactionResponse,
  };

  await assert.rejects(() => release(randomBookingId(), signer, deps), ChainRequestError);
});

test("createBooking rejects a non-finite cancelDeadline with a typed error, before any network access", async () => {
  const signer = Keypair.random();
  const args: CreateBookingArgs = {
    bookingId: randomBookingId(),
    professional: Keypair.random().publicKey(),
    client: signer.publicKey(),
    token: fakeContractId(),
    amount: "1000000",
    cancelDeadline: Number.NaN,
  };

  await assert.rejects(
    // `createBooking` is not itself `async`: it validates and builds its
    // scArgs synchronously before ever returning a promise, so a plain
    // `() => createBooking(...)` would throw synchronously instead of
    // handing assert.rejects a rejected promise. Wrapping in `async`
    // normalizes that.
    async () => createBooking(args, signer, { contractId: fakeContractId(), ...unreachableStages() }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match((error as Error).message, /cancelDeadline/);
      return true;
    },
  );
});
