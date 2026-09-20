/**
 * Passkey pivot: the four `/auth/passkey/...` routes, `GET /me/account` and
 * `POST /me/sign`, driven through Hono's `app.request(...)` like every
 * other `app-*.test.ts`. A synthetic authenticator (`fakeAuthenticator.ts`)
 * completes real registration and login ceremonies; every network seam
 * behind account readiness is injected so nothing leaves the process.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Account, BASE_FEE, Keypair, Networks, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import { createApp, type App } from "../src/app.js";
import { issuePactlyJwt, verifyPactlyJwt } from "../src/auth/challenge.js";
import { getPasskeyCredentialById, getUserByWalletAddress, insertWebauthnChallenge } from "../src/db/users.js";
import { FakeAuthenticator } from "./fakeAuthenticator.js";
import { openTestDatabase, closeDatabase } from "./helpers.js";

const NETWORK = Networks.TESTNET;

function postJson(app: App, path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Registered {
  authenticator: FakeAuthenticator;
  token: string;
  walletAddress: string;
}

/** Runs the whole sign-up ceremony against `app` and returns the session. */
async function registerWithPasskey(app: App, displayName = "Ada"): Promise<Registered> {
  const optionsResponse = await postJson(app, "/auth/passkey/register/options", { displayName });
  assert.equal(optionsResponse.status, 200);
  const { registrationId, options } = (await optionsResponse.json()) as {
    registrationId: string;
    options: { challenge: string; rp: { id: string; name: string }; authenticatorSelection: Record<string, string> };
  };
  const authenticator = new FakeAuthenticator();
  const verifyResponse = await postJson(app, "/auth/passkey/register/verify", {
    registrationId,
    response: authenticator.createRegistrationResponse(options.challenge),
  });
  const verifyText = await verifyResponse.text();
  assert.equal(verifyResponse.status, 201, verifyText);
  const session = JSON.parse(verifyText) as { token: string; walletAddress: string };
  return { authenticator, ...session };
}

test("POST /auth/passkey/register/options returns a ceremony id and discoverable-credential creation options", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await postJson(app, "/auth/passkey/register/options", { displayName: "Ada" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      registrationId: string;
      options: {
        challenge: string;
        rp: { id: string; name: string };
        user: { name: string; displayName: string };
        authenticatorSelection: { residentKey: string; userVerification: string };
      };
    };
    assert.equal(typeof body.registrationId, "string");
    assert.ok(body.options.challenge.length > 0);
    assert.deepEqual(body.options.rp, { id: "localhost", name: "Pactly" });
    assert.equal(body.options.user.displayName, "Ada");
    assert.equal(body.options.authenticatorSelection.residentKey, "required");
    assert.equal(body.options.authenticatorSelection.userVerification, "preferred");
  } finally {
    closeDatabase(result);
  }
});

test("register/verify: an expired or unknown challenge is 410 CHALLENGE_EXPIRED; a live one with a bad response is 401 PASSKEY_INVALID", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);

    const expiredId = randomUUID();
    await insertWebauthnChallenge(result.db, {
      id: expiredId,
      kind: "register",
      challenge: "stale",
      userId: randomUUID(),
      displayName: "Old",
      expiresAt: Date.now() - 1,
    });
    const expired = await postJson(app, "/auth/passkey/register/verify", { registrationId: expiredId, response: {} });
    assert.equal(expired.status, 410);
    assert.equal(((await expired.json()) as { code: string }).code, "CHALLENGE_EXPIRED");

    const unknown = await postJson(app, "/auth/passkey/register/verify", { registrationId: randomUUID(), response: {} });
    assert.equal(unknown.status, 410);

    const optionsResponse = await postJson(app, "/auth/passkey/register/options", {});
    const { registrationId } = (await optionsResponse.json()) as { registrationId: string };
    const invalid = await postJson(app, "/auth/passkey/register/verify", {
      registrationId,
      response: { id: "nope", rawId: "nope", type: "public-key", response: {}, clientExtensionResults: {} },
    });
    assert.equal(invalid.status, 401);
    assert.equal(((await invalid.json()) as { code: string }).code, "PASSKEY_INVALID");

    // The challenge is consumed by the failed attempt: a retry is gone, not invalid.
    const replay = await postJson(app, "/auth/passkey/register/verify", { registrationId, response: {} });
    assert.equal(replay.status, 410);

    const missing = await postJson(app, "/auth/passkey/register/verify", { registrationId });
    assert.equal(missing.status, 400);
  } finally {
    closeDatabase(result);
  }
});

test("a full registration creates the user with a custodial wallet, signs them in, and kicks off account readiness in the background", async () => {
  const result = openTestDatabase();
  try {
    const friendbotCalls: string[] = [];
    const app = createApp(result.db, {
      accountReadyDeps: {
        fetchImpl: async (url) => {
          friendbotCalls.push(url);
          throw new Error("friendbot offline in this test");
        },
      },
    });
    const { token, walletAddress } = await registerWithPasskey(app, "Ada");
    assert.match(walletAddress, /^G[A-Z2-7]{55}$/);
    assert.equal((await verifyPactlyJwt(token)).walletAddress, walletAddress);

    const user = await getUserByWalletAddress(result.db, walletAddress);
    assert.ok(user);
    assert.equal(user.displayName, "Ada");
    assert.notEqual(user.encryptedSecret, "");
    assert.ok(!user.encryptedSecret.startsWith("S"), "the secret is never stored in the clear");

    await tick();
    assert.equal(friendbotCalls.length, 1);
    assert.ok(friendbotCalls[0]?.includes(`addr=${walletAddress}`));

    // GET /me/account reports the flags and retries readiness lazily.
    const me = await app.request("/me/account", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { walletAddress, displayName: "Ada", funded: false, usdcTrustline: false });
    await tick();
    assert.equal(friendbotCalls.length, 2);
  } finally {
    closeDatabase(result);
  }
});

test("POST /auth/passkey/login/options returns a ceremony id and username-less request options", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await postJson(app, "/auth/passkey/login/options", {});
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      loginId: string;
      options: { challenge: string; rpId: string; allowCredentials?: unknown[]; userVerification: string };
    };
    assert.equal(typeof body.loginId, "string");
    assert.ok(body.options.challenge.length > 0);
    assert.equal(body.options.rpId, "localhost");
    assert.deepEqual(body.options.allowCredentials ?? [], []);
    assert.equal(body.options.userVerification, "preferred");
  } finally {
    closeDatabase(result);
  }
});

test("login/verify: unknown credential is 404 PASSKEY_UNKNOWN; a registered passkey signs in, advances its counter, and cannot replay the ceremony", async () => {
  const result = openTestDatabase();
  try {
    let now = Date.now();
    const app = createApp(result.db, {
      passkeyDeps: { now: () => now },
      accountReadyDeps: { fetchImpl: async () => { throw new Error("offline"); } },
    });
    const registered = await registerWithPasskey(app);

    const stranger = new FakeAuthenticator();
    const optionsA = (await (await postJson(app, "/auth/passkey/login/options", {})).json()) as { loginId: string; options: { challenge: string } };
    const unknown = await postJson(app, "/auth/passkey/login/verify", {
      loginId: optionsA.loginId,
      response: stranger.createAuthenticationResponse(optionsA.options.challenge),
    });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code: string }).code, "PASSKEY_UNKNOWN");

    // The unknown attempt never consumed the challenge; the real passkey can still use it.
    const login = await postJson(app, "/auth/passkey/login/verify", {
      loginId: optionsA.loginId,
      response: registered.authenticator.createAuthenticationResponse(optionsA.options.challenge),
    });
    const loginText = await login.text();
    assert.equal(login.status, 200, loginText);
    const session = JSON.parse(loginText) as { token: string; walletAddress: string };
    assert.equal(session.walletAddress, registered.walletAddress);
    assert.equal((await verifyPactlyJwt(session.token)).walletAddress, registered.walletAddress);
    const credential = await getPasskeyCredentialById(result.db, registered.authenticator.credentialIdBase64Url);
    assert.equal(credential?.counter, registered.authenticator.counter);

    // Same ceremony again: consumed, so invalid.
    const replay = await postJson(app, "/auth/passkey/login/verify", {
      loginId: optionsA.loginId,
      response: registered.authenticator.createAuthenticationResponse(optionsA.options.challenge),
    });
    assert.equal(replay.status, 401);
    assert.equal(((await replay.json()) as { code: string }).code, "PASSKEY_INVALID");

    // A signature over some other challenge is invalid.
    const optionsB = (await (await postJson(app, "/auth/passkey/login/options", {})).json()) as { loginId: string; options: { challenge: string } };
    const wrongChallenge = await postJson(app, "/auth/passkey/login/verify", {
      loginId: optionsB.loginId,
      response: registered.authenticator.createAuthenticationResponse("bm90LXRoZS1jaGFsbGVuZ2U"),
    });
    assert.equal(wrongChallenge.status, 401);

    // An expired login challenge is invalid too.
    const optionsC = (await (await postJson(app, "/auth/passkey/login/options", {})).json()) as { loginId: string; options: { challenge: string } };
    now += 6 * 60 * 1000;
    const expired = await postJson(app, "/auth/passkey/login/verify", {
      loginId: optionsC.loginId,
      response: registered.authenticator.createAuthenticationResponse(optionsC.options.challenge),
    });
    assert.equal(expired.status, 401);

    const missing = await postJson(app, "/auth/passkey/login/verify", { loginId: optionsC.loginId });
    assert.equal(missing.status, 400);
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/account and POST /me/sign: 401 without a JWT, 404 NO_CUSTODIAL_ACCOUNT for a legacy wallet JWT", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    assert.equal((await app.request("/me/account")).status, 401);
    assert.equal((await postJson(app, "/me/sign", { unsignedXdr: "AAAA" })).status, 401);

    const legacyToken = await issuePactlyJwt(Keypair.random().publicKey());
    const account = await app.request("/me/account", { headers: { authorization: `Bearer ${legacyToken}` } });
    assert.equal(account.status, 404);
    assert.equal(((await account.json()) as { code: string }).code, "NO_CUSTODIAL_ACCOUNT");

    const sign = await postJson(app, "/me/sign", { unsignedXdr: "AAAA" }, legacyToken);
    assert.equal(sign.status, 404);
    assert.equal(((await sign.json()) as { code: string }).code, "NO_CUSTODIAL_ACCOUNT");
  } finally {
    closeDatabase(result);
  }
});

test("POST /me/sign signs an envelope with the caller's custodial key and refuses bad XDR with 400", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db, {
      accountReadyDeps: { fetchImpl: async () => { throw new Error("offline"); } },
    });
    const { token, walletAddress } = await registerWithPasskey(app);

    const unsigned = new TransactionBuilder(new Account(walletAddress, "0"), { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: (await import("@stellar/stellar-sdk")).Asset.native(), amount: "1" }))
      .setTimeout(300)
      .build();

    const response = await postJson(app, "/me/sign", { unsignedXdr: unsigned.toXDR() }, token);
    const signText = await response.text();
    assert.equal(response.status, 200, signText);
    const { signedXdr } = JSON.parse(signText) as { signedXdr: string };
    const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK) as Transaction;
    assert.equal(signed.signatures.length, 1);
    const signature = signed.signatures[0]?.signature;
    assert.ok(signature);
    assert.ok(Keypair.fromPublicKey(walletAddress).verify(Buffer.from(signed.hash()), signature));
    assert.equal(Buffer.from(signed.hash()).toString("hex"), Buffer.from(unsigned.hash()).toString("hex"));

    const bad = await postJson(app, "/me/sign", { unsignedXdr: "not-xdr" }, token);
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { code: string }).code, "invalid_request");
    const missing = await postJson(app, "/me/sign", {}, token);
    assert.equal(missing.status, 400);
  } finally {
    closeDatabase(result);
  }
});
