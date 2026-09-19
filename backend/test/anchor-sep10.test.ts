/**
 * `anchor/sep10.ts` exercised as a unit: every network stage goes through
 * the injected `Sep10FetchLike` seam, so nothing here ever reaches
 * `tr-mock-anchor.fly.dev`. The fixture challenge is a real SEP-10
 * transaction built with the SDK's own `WebAuth.buildChallengeTx` (the same
 * tool a real anchor would use), so the module under test runs its full,
 * real validate/sign/submit pipeline against it -- only the HTTP transport
 * is faked. Covers the I/O matrix's anchor-SEP-10 success row and both of
 * its failure rows ("Anchor unreachable" for the discovery leg is covered
 * in `anchor-stellar-toml.test.ts`; this file covers the exchange itself).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";

import { runAnchorSep10, type Sep10FetchLike } from "../src/anchor/sep10.js";
import { AnchorAuthError } from "../src/anchor/errors.js";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const HOME_DOMAIN = "tr-mock-anchor.fly.dev";
const WEB_AUTH_ENDPOINT = "https://tr-mock-anchor.fly.dev/auth";
const WEB_AUTH_HOST = new URL(WEB_AUTH_ENDPOINT).host;

function fakeAnchorJwt(sub: string, expiresInSeconds = 86_400): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, iat: nowSeconds, exp: nowSeconds + expiresInSeconds })).toString(
    "base64url",
  );
  return `${header}.${payload}.unsigned`;
}

function buildAnchorChallenge(anchorServer: Keypair, account: string): string {
  return WebAuth.buildChallengeTx(anchorServer, account, HOME_DOMAIN, 300, NETWORK_PASSPHRASE, WEB_AUTH_HOST);
}

test("the full success path: challenge requested, validated, signed, submitted, and the anchor's JWT (with its decoded expiry) returned", async () => {
  const anchorServer = Keypair.random();
  const wallet = Keypair.random();
  const challengeXdr = buildAnchorChallenge(anchorServer, wallet.publicKey());
  const token = fakeAnchorJwt(wallet.publicKey());

  let getCalls = 0;
  let postCalls = 0;
  let submittedTransaction: Transaction | undefined;

  const fetchImpl: Sep10FetchLike = async (url, init) => {
    if (!init || init.method === "GET" || init.method === undefined) {
      getCalls += 1;
      assert.ok(url.startsWith(`${WEB_AUTH_ENDPOINT}?account=`));
      assert.ok(url.includes(encodeURIComponent(wallet.publicKey())));
      return { ok: true, status: 200, json: async () => ({ transaction: challengeXdr }), text: async () => "" };
    }
    postCalls += 1;
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body ?? "{}") as { transaction: string };
    submittedTransaction = TransactionBuilder.fromXdr(body.transaction, NETWORK_PASSPHRASE) as Transaction;
    return { ok: true, status: 200, json: async () => ({ token }), text: async () => "" };
  };

  const result = await runAnchorSep10(
    {
      webAuthEndpoint: WEB_AUTH_ENDPOINT,
      signingKey: anchorServer.publicKey(),
      homeDomain: HOME_DOMAIN,
      networkPassphrase: NETWORK_PASSPHRASE,
      account: wallet.publicKey(),
      signer: wallet,
    },
    fetchImpl,
  );

  assert.equal(getCalls, 1);
  assert.equal(postCalls, 1);
  assert.equal(result.token, token);
  const expectedExpiry = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).exp as number;
  assert.equal(result.expiresAt, expectedExpiry * 1000);
  // Submitted signed by both the anchor (already, in the challenge) and the
  // caller-supplied wallet signer -- the exchange's whole point.
  assert.equal(submittedTransaction?.signatures.length, 2);
});

test("a challenge request the anchor cannot be reached for throws, naming the domain, before anything is signed or submitted", async () => {
  const wallet = Keypair.random();
  const fetchImpl: Sep10FetchLike = async () => {
    throw new Error("connect ECONNREFUSED");
  };

  await assert.rejects(
    () =>
      runAnchorSep10(
        {
          webAuthEndpoint: WEB_AUTH_ENDPOINT,
          signingKey: Keypair.random().publicKey(),
          homeDomain: HOME_DOMAIN,
          networkPassphrase: NETWORK_PASSPHRASE,
          account: wallet.publicKey(),
          signer: wallet,
        },
        fetchImpl,
      ),
    (error: unknown) => error instanceof AnchorAuthError && error.message.includes(HOME_DOMAIN) && error.message.includes("ECONNREFUSED"),
  );
});

test("a non-OK challenge response surfaces the anchor's own reason, and nothing is submitted", async () => {
  const wallet = Keypair.random();
  let postCalled = false;
  const fetchImpl: Sep10FetchLike = async (_url, init) => {
    if (init?.method === "POST") postCalled = true;
    return { ok: false, status: 400, json: async () => ({ error: "unknown account" }), text: async () => "" };
  };

  await assert.rejects(
    () =>
      runAnchorSep10(
        {
          webAuthEndpoint: WEB_AUTH_ENDPOINT,
          signingKey: Keypair.random().publicKey(),
          homeDomain: HOME_DOMAIN,
          networkPassphrase: NETWORK_PASSPHRASE,
          account: wallet.publicKey(),
          signer: wallet,
        },
        fetchImpl,
      ),
    (error: unknown) => error instanceof AnchorAuthError && error.message.includes("unknown account"),
  );
  assert.equal(postCalled, false);
});

test("a challenge signed by a server key other than the discovered SIGNING_KEY is refused before it is ever signed", async () => {
  const wallet = Keypair.random();
  const impostorAnchorServer = Keypair.random();
  const declaredSigningKey = Keypair.random(); // what stellar.toml said, never matches the challenge below
  const challengeXdr = buildAnchorChallenge(impostorAnchorServer, wallet.publicKey());

  const fetchImpl: Sep10FetchLike = async (_url, init) => {
    if (init?.method === "POST") throw new Error("must not submit an unvalidated challenge");
    return { ok: true, status: 200, json: async () => ({ transaction: challengeXdr }), text: async () => "" };
  };

  await assert.rejects(
    () =>
      runAnchorSep10(
        {
          webAuthEndpoint: WEB_AUTH_ENDPOINT,
          signingKey: declaredSigningKey.publicKey(),
          homeDomain: HOME_DOMAIN,
          networkPassphrase: NETWORK_PASSPHRASE,
          account: wallet.publicKey(),
          signer: wallet,
        },
        fetchImpl,
      ),
    AnchorAuthError,
  );
});

test("the anchor rejecting the signed challenge (invalid signature) throws surfacing its own reason, and stores nothing here", async () => {
  const anchorServer = Keypair.random();
  const wallet = Keypair.random();
  const challengeXdr = buildAnchorChallenge(anchorServer, wallet.publicKey());

  const fetchImpl: Sep10FetchLike = async (_url, init) => {
    if (!init || init.method === "GET" || init.method === undefined) {
      return { ok: true, status: 200, json: async () => ({ transaction: challengeXdr }), text: async () => "" };
    }
    return { ok: false, status: 401, json: async () => ({ error: "signature verification failed" }), text: async () => "" };
  };

  await assert.rejects(
    () =>
      runAnchorSep10(
        {
          webAuthEndpoint: WEB_AUTH_ENDPOINT,
          signingKey: anchorServer.publicKey(),
          homeDomain: HOME_DOMAIN,
          networkPassphrase: NETWORK_PASSPHRASE,
          account: wallet.publicKey(),
          signer: wallet,
        },
        fetchImpl,
      ),
    (error: unknown) => error instanceof AnchorAuthError && error.message.includes("signature verification failed"),
  );
});

test("a token response missing the token field throws", async () => {
  const anchorServer = Keypair.random();
  const wallet = Keypair.random();
  const challengeXdr = buildAnchorChallenge(anchorServer, wallet.publicKey());

  const fetchImpl: Sep10FetchLike = async (_url, init) => {
    if (!init || init.method === "GET" || init.method === undefined) {
      return { ok: true, status: 200, json: async () => ({ transaction: challengeXdr }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };

  await assert.rejects(
    () =>
      runAnchorSep10(
        {
          webAuthEndpoint: WEB_AUTH_ENDPOINT,
          signingKey: anchorServer.publicKey(),
          homeDomain: HOME_DOMAIN,
          networkPassphrase: NETWORK_PASSPHRASE,
          account: wallet.publicKey(),
          signer: wallet,
        },
        fetchImpl,
      ),
    AnchorAuthError,
  );
});
