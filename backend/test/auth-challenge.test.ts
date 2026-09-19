/**
 * `auth/challenge.ts` exercised as a unit: Pactly's own SEP-10-shaped
 * challenge (issued and verified entirely by this backend, never the
 * anchor's) and its own JWT. Nothing here reaches the network -- challenge
 * construction/verification is pure cryptography over a transaction
 * envelope, and clock-dependent cases (challenge expiry, JWT expiry) are
 * driven through an injected/mocked clock rather than a real wait, per the
 * story's own testing constraint. Covers the I/O matrix's full
 * chain-of-custody for Pactly's login: challenge issued -> signed ->
 * verified -> JWT usable, plus every refusal row.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import {
  buildPactlyChallenge,
  issuePactlyJwt,
  verifyPactlyChallenge,
  verifyPactlyJwt,
} from "../src/auth/challenge.js";
import {
  PactlyChallengeExpiredError,
  PactlyChallengeInvalidError,
  PactlyInvalidAccountError,
  PactlyJwtError,
} from "../src/auth/errors.js";
import { config } from "../src/config.js";

/** Decodes a challenge XDR and signs it as the given wallet, returning the
 * base64 envelope a caller would submit to `/auth/verify`. */
function signChallenge(challengeXdr: string, wallet: Keypair): string {
  const tx = TransactionBuilder.fromXdr(challengeXdr, config.stellarNetworkPassphrase) as Transaction;
  tx.sign(wallet);
  return tx.toXdr();
}

test("buildPactlyChallenge issues a challenge naming the wallet and PACTLY_HOME_DOMAIN, signed by Pactly's own key", () => {
  const wallet = Keypair.random();
  const challengeXdr = buildPactlyChallenge(wallet.publicKey());
  const tx = new Transaction(challengeXdr, config.stellarNetworkPassphrase);
  const [operation] = tx.operations;
  assert.equal(operation?.type, "manageData");
  assert.equal(operation && "name" in operation ? operation.name : undefined, `${config.pactlyHomeDomain} auth`);
  assert.equal(operation?.source, wallet.publicKey());
  // Signed once already (by Pactly's own server key) -- not yet by the
  // wallet, which is exactly what makes it a challenge to sign.
  assert.equal(tx.signatures.length, 1);
});

test("buildPactlyChallenge rejects a public key that is not a valid Stellar account id", () => {
  assert.throws(() => buildPactlyChallenge("not-a-real-account"), PactlyInvalidAccountError);
});

test("chain of custody: challenge issued -> signed by the named wallet -> verified -> Pactly JWT usable", async () => {
  const wallet = Keypair.random();
  const challengeXdr = buildPactlyChallenge(wallet.publicKey());
  const signedXdr = signChallenge(challengeXdr, wallet);

  const verified = verifyPactlyChallenge(signedXdr);
  assert.equal(verified.walletAddress, wallet.publicKey());

  const token = await issuePactlyJwt(verified.walletAddress);
  const session = await verifyPactlyJwt(token);
  assert.equal(session.walletAddress, wallet.publicKey());
});

test("verifyPactlyChallenge rejects a challenge signed by a different key", () => {
  const named = Keypair.random();
  const impostor = Keypair.random();
  const challengeXdr = buildPactlyChallenge(named.publicKey());
  const signedByImpostor = signChallenge(challengeXdr, impostor);

  assert.throws(() => verifyPactlyChallenge(signedByImpostor), PactlyChallengeInvalidError);
});

test("verifyPactlyChallenge rejects an unsigned challenge with the same error shape as a wrong-signer one", () => {
  const named = Keypair.random();
  const challengeXdr = buildPactlyChallenge(named.publicKey());
  // Never signed by the wallet at all (only by Pactly's own server key,
  // already present in `challengeXdr`).

  const impostor = Keypair.random();
  const signedByImpostor = signChallenge(challengeXdr, impostor);

  let unsignedError: unknown;
  let wrongSignerError: unknown;
  try {
    verifyPactlyChallenge(challengeXdr);
  } catch (error) {
    unsignedError = error;
  }
  try {
    verifyPactlyChallenge(signedByImpostor);
  } catch (error) {
    wrongSignerError = error;
  }

  assert.ok(unsignedError instanceof PactlyChallengeInvalidError);
  assert.ok(wrongSignerError instanceof PactlyChallengeInvalidError);
  assert.equal((unsignedError as Error).name, (wrongSignerError as Error).name);
  assert.equal((unsignedError as Error).message, (wrongSignerError as Error).message);
});

test("verifyPactlyChallenge rejects an expired challenge, naming the expiry", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const wallet = Keypair.random();
  const challengeXdr = buildPactlyChallenge(wallet.publicKey());
  const signedXdr = signChallenge(challengeXdr, wallet);

  // The challenge's own 300s timeout, plus the SDK's own 300s grace period
  // (baked into readChallengeTx/verifyChallengeTxSigners) -- past both.
  t.mock.timers.tick(601_000);

  assert.throws(() => verifyPactlyChallenge(signedXdr), (error: unknown) => {
    assert.ok(error instanceof PactlyChallengeExpiredError);
    assert.match(error.message, /expired/i);
    return true;
  });
});

test("issuePactlyJwt + verifyPactlyJwt round-trips the wallet address", async () => {
  const wallet = Keypair.random();
  const token = await issuePactlyJwt(wallet.publicKey());
  const session = await verifyPactlyJwt(token);
  assert.equal(session.walletAddress, wallet.publicKey());
});

test("verifyPactlyJwt rejects an expired JWT", async () => {
  const wallet = Keypair.random();
  const issuedAt = new Date("2026-01-01T00:00:00Z");
  const token = await issuePactlyJwt(wallet.publicKey(), { now: () => issuedAt });

  const wellPastExpiry = () => new Date(issuedAt.getTime() + 2 * 3600 * 1000); // 2h later; TTL is 1h.
  await assert.rejects(() => verifyPactlyJwt(token, { now: wellPastExpiry }), PactlyJwtError);
});

test("verifyPactlyJwt rejects a tampered JWT (payload altered after signing) with the same shape as an expired one", async () => {
  const wallet = Keypair.random();
  const issuedAt = new Date("2026-01-01T00:00:00Z");
  const token = await issuePactlyJwt(wallet.publicKey(), { now: () => issuedAt });

  const [header, payload, signature] = token.split(".");
  const decodedPayload = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  decodedPayload.sub = Keypair.random().publicKey(); // a different wallet than what was signed
  const tamperedPayload = Buffer.from(JSON.stringify(decodedPayload)).toString("base64url");
  const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

  let tamperedError: unknown;
  let expiredError: unknown;
  try {
    await verifyPactlyJwt(tamperedToken);
  } catch (error) {
    tamperedError = error;
  }
  try {
    await verifyPactlyJwt(token, { now: () => new Date(issuedAt.getTime() + 2 * 3600 * 1000) });
  } catch (error) {
    expiredError = error;
  }

  assert.ok(tamperedError instanceof PactlyJwtError);
  assert.ok(expiredError instanceof PactlyJwtError);
  assert.equal((tamperedError as Error).name, (expiredError as Error).name);
  assert.equal((tamperedError as Error).message, (expiredError as Error).message);
});

test("verifyPactlyJwt rejects a missing token", async () => {
  await assert.rejects(() => verifyPactlyJwt(""), PactlyJwtError);
});

test("verifyPactlyJwt rejects a token signed with the wrong secret", async () => {
  const wallet = Keypair.random();
  // A structurally valid JWT this backend never issued -- same class of
  // forgery attempt a tampered signature is.
  const { SignJWT } = await import("jose");
  const forged = await new SignJWT({ sub: wallet.publicKey() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("not-the-real-secret"));

  await assert.rejects(() => verifyPactlyJwt(forged), PactlyJwtError);
});
