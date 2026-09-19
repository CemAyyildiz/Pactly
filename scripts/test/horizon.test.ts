import assert from "node:assert/strict";
import { test } from "node:test";

import { Account, Asset, Keypair, Networks } from "@stellar/stellar-sdk";

import { addTrustline, fundViaFriendbot, FriendbotError, horizonServer, TrustlineError } from "../src/horizon.js";
import type { SubmitTransaction } from "../src/horizon.js";

const PUBLIC_KEY = "GDEMOACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function refusalWith(data: Record<string, unknown>): () => Promise<never> {
  return async () => {
    const error = new Error("Bad Request") as Error & { response: { data: unknown } };
    error.response = { data };
    throw error;
  };
}

test("fundViaFriendbot surfaces friendbot's own reason when refused", async () => {
  const server = horizonServer();
  await assert.rejects(
    () => fundViaFriendbot(server, PUBLIC_KEY, refusalWith({ detail: "Friendbot is out of funds" })),
    (error: unknown) => error instanceof FriendbotError && /Friendbot is out of funds/.test(error.message),
  );
});

test("fundViaFriendbot treats an already-funded refusal as success", async () => {
  const server = horizonServer();
  await assert.doesNotReject(() =>
    fundViaFriendbot(
      server,
      PUBLIC_KEY,
      refusalWith({
        detail: "createAccountAlreadyExist",
        extras: { result_codes: { operations: ["op_already_exists"] } },
      }),
    ),
  );
});

test("fundViaFriendbot treats an already-funded message without result codes as success too", async () => {
  const server = horizonServer();
  await assert.doesNotReject(() =>
    fundViaFriendbot(server, PUBLIC_KEY, refusalWith({ title: "Account already exists" })),
  );
});

test("fundViaFriendbot succeeds when the call succeeds", async () => {
  const server = horizonServer();
  await assert.doesNotReject(() => fundViaFriendbot(server, PUBLIC_KEY, async () => undefined));
});

const USDC_ISSUER = "GB23LBWL5BNFPBRFPR3KI4RT6EVUL77VKNCH4D5IEXF7PESQTEY4KC4S";

function trustlineFixture() {
  const server = horizonServer();
  const signer = Keypair.random();
  const account = new Account(signer.publicKey(), "1");
  const asset = new Asset("USDC", USDC_ISSUER);
  return { server, signer, account, asset };
}

test("addTrustline surfaces Horizon's own rejection reason instead of the generic HTTP message", async () => {
  const { server, signer, account, asset } = trustlineFixture();
  const submit: SubmitTransaction = async () => {
    const error = new Error("Request failed with status code 400") as Error & { response: { data: unknown } };
    error.response = {
      data: {
        title: "Transaction Failed",
        extras: { result_codes: { transaction: "tx_failed", operations: ["op_low_reserve"] } },
      },
    };
    throw error;
  };
  await assert.rejects(
    () => addTrustline(server, account, signer, asset, Networks.TESTNET, submit),
    (error: unknown) =>
      error instanceof TrustlineError &&
      /Transaction Failed/.test(error.message) &&
      /op_low_reserve/.test(error.message) &&
      !/Request failed with status code 400/.test(error.message),
  );
});

test("addTrustline succeeds when submit succeeds", async () => {
  const { server, signer, account, asset } = trustlineFixture();
  await assert.doesNotReject(() => addTrustline(server, account, signer, asset, Networks.TESTNET, async () => undefined));
});
