/**
 * The embedded custodial account: secret encryption at rest, signing on a
 * user's behalf (`custodial/keys.ts`), and the best-effort friendbot +
 * trustline readiness job (`custodial/funding.ts`) with every network seam
 * faked.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Account, Asset, BASE_FEE, Keypair, Networks, Operation, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

import { resetUsdcAssetCacheForTests } from "../src/anchor/usdc.js";
import { AccountFundingError, InvalidXdrError, NoCustodialAccountError } from "../src/custodial/errors.js";
import { ensureAccountReady, type EnsureAccountReadyDeps } from "../src/custodial/funding.js";
import { decryptSecret, encryptSecret, signXdrForWallet } from "../src/custodial/keys.js";
import { getUserByWalletAddress, insertUser } from "../src/db/users.js";
import type { Db } from "../src/db/client.js";
import { openTestDatabase, closeDatabase } from "./helpers.js";

const NETWORK = Networks.TESTNET;
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const REALISTIC_TOML = `
WEB_AUTH_ENDPOINT="https://tr-mock-anchor.fly.dev/auth"
SIGNING_KEY="GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
`;

/** Registers a custodial user directly (no passkey) and returns its keypair. */
async function seedCustodialUser(db: Db, flags: { funded?: boolean; usdcTrustline?: boolean } = {}): Promise<Keypair> {
  const keypair = Keypair.random();
  await insertUser(db, {
    id: randomUUID(),
    displayName: "Seeded",
    walletAddress: keypair.publicKey(),
    encryptedSecret: encryptSecret(keypair.secret()),
    createdAt: Date.now(),
  });
  if (flags.funded || flags.usdcTrustline) {
    const { setUserAccountFlags } = await import("../src/db/users.js");
    const user = await getUserByWalletAddress(db, keypair.publicKey());
    await setUserAccountFlags(db, user!.id, flags);
  }
  return keypair;
}

function buildPayment(source: string): Transaction {
  return new TransactionBuilder(new Account(source, "0"), { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(300)
    .build();
}

test("encryptSecret/decryptSecret round-trip, with a fresh IV per call and a tamper-evident tag", () => {
  const secret = Keypair.random().secret();
  const first = encryptSecret(secret);
  const second = encryptSecret(secret);
  assert.notEqual(first, second);
  assert.ok(!first.includes(secret));
  assert.equal(decryptSecret(first), secret);
  assert.equal(decryptSecret(second), secret);

  const [version, iv, tag, ciphertext] = first.split(".");
  const flipped = Buffer.from(ciphertext!, "base64url");
  flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
  assert.throws(() => decryptSecret([version, iv, tag, flipped.toString("base64url")].join(".")));
  assert.throws(() => decryptSecret("garbage"));
});

test("signXdrForWallet signs a plain transaction with the user's custodial key and leaves the hash unchanged", async () => {
  const result = openTestDatabase();
  try {
    const keypair = await seedCustodialUser(result.db);
    const unsigned = buildPayment(keypair.publicKey());
    const signedXdr = await signXdrForWallet(result.db, keypair.publicKey(), unsigned.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK) as Transaction;
    assert.equal(signed.signatures.length, 1);
    assert.ok(keypair.verify(Buffer.from(signed.hash()), signed.signatures[0]!.signature));
    assert.deepEqual(signed.hash(), unsigned.hash());
  } finally {
    closeDatabase(result);
  }
});

test("signXdrForWallet also signs a fee-bump envelope", async () => {
  const result = openTestDatabase();
  try {
    const keypair = await seedCustodialUser(result.db);
    const inner = buildPayment(Keypair.random().publicKey());
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(keypair.publicKey(), "1000", inner, NETWORK);
    const signedXdr = await signXdrForWallet(result.db, keypair.publicKey(), feeBump.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK);
    assert.ok(!(signed instanceof Transaction));
    assert.equal(signed.signatures.length, 1);
    assert.ok(keypair.verify(Buffer.from(signed.hash()), signed.signatures[0]!.signature));
  } finally {
    closeDatabase(result);
  }
});

test("signXdrForWallet refuses an unknown wallet and undecodable XDR with typed errors", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(
      signXdrForWallet(result.db, Keypair.random().publicKey(), buildPayment(Keypair.random().publicKey()).toXDR()),
      NoCustodialAccountError,
    );
    const keypair = await seedCustodialUser(result.db);
    await assert.rejects(signXdrForWallet(result.db, keypair.publicKey(), "not xdr at all"), InvalidXdrError);
  } finally {
    closeDatabase(result);
  }
});

interface FakeNetwork {
  deps: EnsureAccountReadyDeps;
  friendbotCalls: number;
  submitted: Transaction[];
}

function fakeNetwork(options: { friendbot?: (url: string) => Promise<{ ok: boolean; status: number; text: string }> } = {}): FakeNetwork {
  const state: FakeNetwork = { friendbotCalls: 0, submitted: [], deps: {} };
  state.deps = {
    friendbotUrl: "https://friendbot.test",
    fetchImpl: async (url) => {
      if (url.endsWith("/.well-known/stellar.toml")) {
        return { ok: true, status: 200, text: async () => REALISTIC_TOML, json: async () => ({}) };
      }
      if (url.startsWith("https://friendbot.test")) {
        state.friendbotCalls += 1;
        const reply = options.friendbot ? await options.friendbot(url) : { ok: true, status: 200, text: "{}" };
        return { ok: reply.ok, status: reply.status, text: async () => reply.text, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    buildTrustline: { getAccount: async (publicKey) => new Account(publicKey, "7") },
    submitTrustline: {
      sendTransaction: async (tx) => {
        state.submitted.push(tx);
        return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex") } as rpc.Api.SendTransactionResponse;
      },
      waitForTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as rpc.Api.GetTransactionResponse,
    },
  };
  return state;
}

test("ensureAccountReady funds via friendbot, opens the USDC trustline signed by the custodial key, and sets both flags once", async () => {
  resetUsdcAssetCacheForTests();
  const result = openTestDatabase();
  try {
    const keypair = await seedCustodialUser(result.db);
    const network = fakeNetwork();
    const readiness = await ensureAccountReady(result.db, keypair.publicKey(), network.deps);
    assert.deepEqual(readiness, { funded: true, usdcTrustline: true });
    assert.equal(network.friendbotCalls, 1);
    assert.equal(network.submitted.length, 1);
    const trustline = network.submitted[0]!;
    assert.equal(trustline.source, keypair.publicKey());
    assert.equal(trustline.operations[0]?.type, "changeTrust");
    assert.ok(keypair.verify(Buffer.from(trustline.hash()), trustline.signatures[0]!.signature));

    const user = await getUserByWalletAddress(result.db, keypair.publicKey());
    assert.equal(user?.funded, true);
    assert.equal(user?.usdcTrustline, true);

    // Idempotent: nothing touches the network the second time.
    await ensureAccountReady(result.db, keypair.publicKey(), network.deps);
    assert.equal(network.friendbotCalls, 1);
    assert.equal(network.submitted.length, 1);
  } finally {
    closeDatabase(result);
  }
});

test("ensureAccountReady treats friendbot's 'already exists' as funded, and retries a failed step next time without redoing a finished one", async () => {
  resetUsdcAssetCacheForTests();
  const result = openTestDatabase();
  try {
    const keypair = await seedCustodialUser(result.db);
    let refuse = true;
    const network = fakeNetwork({
      friendbot: async () =>
        refuse
          ? { ok: false, status: 503, text: "friendbot down" }
          : { ok: false, status: 400, text: JSON.stringify({ extras: { result_codes: { operations: ["op_already_exists"] } } }) },
    });
    await assert.rejects(ensureAccountReady(result.db, keypair.publicKey(), network.deps), AccountFundingError);
    let user = await getUserByWalletAddress(result.db, keypair.publicKey());
    assert.equal(user?.funded, false);
    assert.equal(network.submitted.length, 0, "no trustline is attempted for an unfunded account");

    refuse = false;
    const readiness = await ensureAccountReady(result.db, keypair.publicKey(), network.deps);
    assert.deepEqual(readiness, { funded: true, usdcTrustline: true });
    user = await getUserByWalletAddress(result.db, keypair.publicKey());
    assert.equal(user?.funded, true);
    assert.equal(user?.usdcTrustline, true);
    assert.equal(network.friendbotCalls, 2);
    assert.equal(network.submitted.length, 1);
  } finally {
    closeDatabase(result);
  }
});

test("ensureAccountReady skips friendbot for an already-funded account and refuses an unknown wallet", async () => {
  resetUsdcAssetCacheForTests();
  const result = openTestDatabase();
  try {
    const keypair = await seedCustodialUser(result.db, { funded: true });
    const network = fakeNetwork();
    await ensureAccountReady(result.db, keypair.publicKey(), network.deps);
    assert.equal(network.friendbotCalls, 0);
    assert.equal(network.submitted.length, 1);
    await assert.rejects(ensureAccountReady(result.db, Keypair.random().publicKey(), network.deps), NoCustodialAccountError);
  } finally {
    closeDatabase(result);
  }
});
