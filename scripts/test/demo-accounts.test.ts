import assert from "node:assert/strict";
import { test } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { DEMO_ROLES, resolveDemoKeypair, secretEnvVar, TRUSTLINE_ROLES, unionAdminWallets } from "../src/demo-accounts.js";

test("secretEnvVar names one key per role", () => {
  assert.equal(secretEnvVar("admin"), "PACTLY_DEMO_ADMIN_SECRET");
  assert.equal(secretEnvVar("professional"), "PACTLY_DEMO_PROFESSIONAL_SECRET");
  assert.equal(secretEnvVar("client"), "PACTLY_DEMO_CLIENT_SECRET");
});

test("every demo role has a distinct secret env var", () => {
  const names = DEMO_ROLES.map(secretEnvVar);
  assert.equal(new Set(names).size, names.length);
});

test("only the professional and client roles need the trustline", () => {
  assert.deepEqual([...TRUSTLINE_ROLES].sort(), ["client", "professional"]);
  assert.equal(TRUSTLINE_ROLES.includes("admin"), false);
});

test("resolveDemoKeypair reuses an operator-supplied secret instead of generating one", () => {
  const existing = Keypair.random();
  const resolved = resolveDemoKeypair(existing.secret());
  assert.equal(resolved.isNew, false);
  assert.equal(resolved.keypair.publicKey(), existing.publicKey());
});

test("resolveDemoKeypair generates a fresh keypair when none is set", () => {
  const resolved = resolveDemoKeypair(undefined);
  assert.equal(resolved.isNew, true);
  assert.match(resolved.keypair.publicKey(), /^G[A-Z0-9]{55}$/);
});

test("resolveDemoKeypair treats a blank secret the same as none set", () => {
  const resolved = resolveDemoKeypair("   ");
  assert.equal(resolved.isNew, true);
});

test("resolveDemoKeypair names the offending variable when the secret is malformed", () => {
  assert.throws(
    () => resolveDemoKeypair("not-a-secret-key", "PACTLY_DEMO_CLIENT_SECRET"),
    (error: unknown) => error instanceof Error && error.message.includes("PACTLY_DEMO_CLIENT_SECRET"),
  );
});

test("unionAdminWallets adds the demo admin to an empty list", () => {
  assert.equal(unionAdminWallets(undefined, "GADMIN"), "GADMIN");
  assert.equal(unionAdminWallets("", "GADMIN"), "GADMIN");
});

test("unionAdminWallets keeps an operator's existing wallets, appending the demo admin", () => {
  assert.equal(unionAdminWallets("GOPERATOR1,GOPERATOR2", "GADMIN"), "GOPERATOR1,GOPERATOR2,GADMIN");
});

test("unionAdminWallets does not duplicate the demo admin if it is already listed", () => {
  assert.equal(unionAdminWallets("GOPERATOR1,GADMIN,GOPERATOR2", "GADMIN"), "GOPERATOR1,GADMIN,GOPERATOR2");
});

test("unionAdminWallets trims whitespace and drops empty entries", () => {
  assert.equal(unionAdminWallets(" GOPERATOR1 , , GOPERATOR2 ", "GADMIN"), "GOPERATOR1,GOPERATOR2,GADMIN");
});
