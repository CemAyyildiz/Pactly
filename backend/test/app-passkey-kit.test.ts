/**
 * Passkey Kit session route: a `C…` smart-wallet id becomes a Pactly JWT.
 * Submit is not exercised here (it talks to testnet).
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { StrKey } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import { verifyPactlyJwt } from "../src/auth/challenge.js";
import { PASSKEY_KIT_SECRET_MARKER, passkeyKitRailKeypair } from "../src/auth/passkeyKit.js";
import { getUserByWalletAddress, insertUser } from "../src/db/users.js";
import { closeDatabase, openTestDatabase } from "./helpers.js";

function postJson(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /auth/passkey-kit/session issues a JWT for the G… rail behind a C… contract and refuses a G… address", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);

    const missing = await postJson(app, "/auth/passkey-kit/session", {});
    assert.equal(missing.status, 400);

    const classic = await postJson(app, "/auth/passkey-kit/session", {
      contractId: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    });
    assert.equal(classic.status, 400);
    const classicBody = (await classic.json()) as { code: string };
    assert.equal(classicBody.code, "PASSKEY_KIT_ACCOUNT");

    // A well-formed contract id (not necessarily on-ledger — session only
    // records identity; deploy is a separate submit).
    const bytes = Buffer.alloc(32, 7);
    const contractId = StrKey.encodeContract(bytes);
    const railAddress = passkeyKitRailKeypair(contractId).publicKey();
    const created = await postJson(app, "/auth/passkey-kit/session", { contractId });
    assert.equal(created.status, 201);
    const session = (await created.json()) as { token: string; walletAddress: string; contractId: string };
    assert.equal(session.walletAddress, railAddress);
    assert.equal(session.contractId, contractId);
    assert.ok(StrKey.isValidEd25519PublicKey(session.walletAddress));
    const verified = await verifyPactlyJwt(session.token);
    assert.equal(verified.walletAddress, railAddress);

    const user = await getUserByWalletAddress(result.db, railAddress);
    assert.ok(user);
    assert.notEqual(user.encryptedSecret, PASSKEY_KIT_SECRET_MARKER);
    assert.equal(await getUserByWalletAddress(result.db, contractId), undefined);

    const again = await postJson(app, "/auth/passkey-kit/session", { contractId });
    assert.equal(again.status, 201);
    const againBody = (await again.json()) as { walletAddress: string };
    assert.equal(againBody.walletAddress, railAddress);
  } finally {
    closeDatabase(result);
  }
});

test("POST /auth/passkey-kit/session migrates a leftover C… marker row onto the G… rail", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const bytes = Buffer.alloc(32, 9);
    const contractId = StrKey.encodeContract(bytes);
    const railAddress = passkeyKitRailKeypair(contractId).publicKey();
    await insertUser(result.db, {
      id: "legacy-passkey-kit",
      displayName: "",
      walletAddress: contractId,
      encryptedSecret: PASSKEY_KIT_SECRET_MARKER,
      createdAt: 1,
    });

    const created = await postJson(app, "/auth/passkey-kit/session", { contractId });
    assert.equal(created.status, 201);
    const session = (await created.json()) as { walletAddress: string };
    assert.equal(session.walletAddress, railAddress);
    assert.equal(await getUserByWalletAddress(result.db, contractId), undefined);
    const user = await getUserByWalletAddress(result.db, railAddress);
    assert.ok(user);
    assert.equal(user.id, "legacy-passkey-kit");
    assert.notEqual(user.encryptedSecret, PASSKEY_KIT_SECRET_MARKER);
  } finally {
    closeDatabase(result);
  }
});

test("POST /auth/passkey-kit/submit refuses a missing envelope", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await postJson(app, "/auth/passkey-kit/submit", {});
    assert.equal(response.status, 400);
  } finally {
    closeDatabase(result);
  }
});
