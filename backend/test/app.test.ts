/**
 * The HTTP layer (`app.ts`): `/auth/challenge`, `/auth/verify`, and
 * `requirePactlyAuth`, driven through Hono's own `app.request(...)` --
 * never a real listening socket (that is `db.test.ts`'s job, black-box,
 * for `/health` alone). Nothing here reaches the network: Pactly's own
 * challenge/JWT machinery is pure local cryptography. Covers the story's
 * own Acceptance Criteria end to end at the HTTP boundary, including the
 * "the anchor's JWT never appears in this backend's own responses" manual
 * check turned into an assertion (trivially true here since this story
 * wires no route that ever touches the anchor JWT, but asserted anyway so
 * a later story that reuses `/auth/verify` cannot regress it unnoticed).
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import { createApp, requirePactlyAuth, type Variables } from "../src/app.js";
import { config } from "../src/config.js";

function signChallenge(challengeXdr: string, wallet: Keypair): string {
  const tx = TransactionBuilder.fromXdr(challengeXdr, config.stellarNetworkPassphrase) as Transaction;
  tx.sign(wallet);
  return tx.toXdr();
}

/** A throwaway app with one route behind `requirePactlyAuth` -- this
 * story's own middleware, exercised through Hono's real request pipeline.
 * No production route needs authorization yet (Epic 3/4's job), so there
 * is nothing to protect in `createApp()` itself; this is the same pattern
 * a later story's route will follow. */
function createProtectedTestApp() {
  const app = new Hono<{ Variables: Variables }>();
  app.get("/protected", requirePactlyAuth, (c) => c.json({ walletAddress: c.get("walletAddress") }));
  return app;
}

test("POST /auth/challenge returns a challenge transaction for a valid public key", async () => {
  const app = createApp();
  const wallet = Keypair.random();
  const response = await app.request("/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: wallet.publicKey() }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { transaction: string };
  assert.equal(typeof body.transaction, "string");
  const tx = new Transaction(body.transaction, config.stellarNetworkPassphrase);
  assert.equal(tx.operations[0]?.source, wallet.publicKey());
});

test("POST /auth/challenge rejects a missing publicKey with 400", async () => {
  const app = createApp();
  const response = await app.request("/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
});

test("POST /auth/challenge rejects a malformed publicKey with 400, not a stack trace", async () => {
  const app = createApp();
  const response = await app.request("/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: "not-a-real-account" }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "invalid_account");
});

test("chain of custody over HTTP: challenge -> signed -> verified -> Pactly JWT usable against requirePactlyAuth", async () => {
  const app = createApp();
  const wallet = Keypair.random();

  const challengeResponse = await app.request("/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: wallet.publicKey() }),
  });
  const { transaction } = (await challengeResponse.json()) as { transaction: string };
  const signedXdr = signChallenge(transaction, wallet);

  const verifyResponse = await app.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: signedXdr }),
  });
  assert.equal(verifyResponse.status, 200);
  const verifyBody = (await verifyResponse.json()) as Record<string, unknown>;
  assert.equal(verifyBody.walletAddress, wallet.publicKey());
  assert.equal(typeof verifyBody.token, "string");
  // The story's own manual check, as an assertion: only a Pactly JWT and
  // the wallet address it names ever leave this endpoint.
  assert.deepEqual(new Set(Object.keys(verifyBody)), new Set(["token", "walletAddress"]));

  const protectedApp = createProtectedTestApp();
  const protectedResponse = await protectedApp.request("/protected", {
    headers: { authorization: `Bearer ${verifyBody.token}` },
  });
  assert.equal(protectedResponse.status, 200);
  const protectedBody = (await protectedResponse.json()) as { walletAddress: string };
  assert.equal(protectedBody.walletAddress, wallet.publicKey());
});

test("POST /auth/verify rejects a challenge signed by the wrong wallet with 401", async () => {
  const app = createApp();
  const named = Keypair.random();
  const impostor = Keypair.random();

  const challengeResponse = await app.request("/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: named.publicKey() }),
  });
  const { transaction } = (await challengeResponse.json()) as { transaction: string };
  const signedByImpostor = signChallenge(transaction, impostor);

  const verifyResponse = await app.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: signedByImpostor }),
  });
  assert.equal(verifyResponse.status, 401);
  const body = (await verifyResponse.json()) as { code: string };
  assert.equal(body.code, "challenge_invalid");
});

test("POST /auth/verify rejects a missing transaction with 400", async () => {
  const app = createApp();
  const response = await app.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
});

test("requirePactlyAuth rejects a request with no Authorization header", async () => {
  const protectedApp = createProtectedTestApp();
  const response = await protectedApp.request("/protected");
  assert.equal(response.status, 401);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "unauthorized");
});

test("requirePactlyAuth rejects a tampered bearer token", async () => {
  const protectedApp = createProtectedTestApp();
  const response = await protectedApp.request("/protected", {
    headers: { authorization: "Bearer not.a.realtoken" },
  });
  assert.equal(response.status, 401);
});
