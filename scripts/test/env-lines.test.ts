import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { shapeEnvLine, shapeEnvLines } from "../src/env-lines.js";

test("shapeEnvLine leaves a simple value unquoted", () => {
  assert.equal(shapeEnvLine("ESCROW_CONTRACT_ID", "CABCDEF"), "ESCROW_CONTRACT_ID=CABCDEF");
});

test("shapeEnvLine leaves an empty value unquoted", () => {
  assert.equal(shapeEnvLine("ESCROW_CONTRACT_ID", ""), "ESCROW_CONTRACT_ID=");
});

test("shapeEnvLine leaves a comma-separated list unquoted", () => {
  assert.equal(
    shapeEnvLine("PACTLY_ADMIN_WALLETS", "GABC,GDEF"),
    "PACTLY_ADMIN_WALLETS=GABC,GDEF",
  );
});

test("shapeEnvLine leaves a URL unquoted", () => {
  assert.equal(
    shapeEnvLine("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org"),
    "SOROBAN_RPC_URL=https://soroban-testnet.stellar.org",
  );
});

test("shapeEnvLine quotes a value with spaces and punctuation", () => {
  assert.equal(
    shapeEnvLine("STELLAR_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015"),
    "STELLAR_NETWORK_PASSPHRASE='Test SDF Network ; September 2015'",
  );
});

test("shapeEnvLine quotes a value containing double quotes without escaping them", () => {
  assert.equal(shapeEnvLine("NOTE", 'He said "hi" \\ bye'), "NOTE='He said \"hi\" \\ bye'");
});

test("shapeEnvLine rejects a value it cannot faithfully encode (a single quote)", () => {
  assert.throws(() => shapeEnvLine("NOTE", "it's here"), /cannot be encoded/);
});

test("shapeEnvLine rejects a value containing a literal newline", () => {
  assert.throws(() => shapeEnvLine("NOTE", "line1\nline2"), /cannot be encoded/);
});

test("shapeEnvLine rejects an invalid key", () => {
  assert.throws(() => shapeEnvLine("not a key", "value"), /not a valid \.env key/);
});

test("shapeEnvLines renders one line per entry in insertion order", () => {
  const lines = shapeEnvLines({
    ESCROW_CONTRACT_ID: "CABCDEF",
    PACTLY_ADMIN_WALLETS: "GABC,GDEF",
  });
  assert.equal(lines, "ESCROW_CONTRACT_ID=CABCDEF\nPACTLY_ADMIN_WALLETS=GABC,GDEF");
});

test("shapeEnvLines round-trips through process.loadEnvFile", () => {
  const values = {
    ESCROW_CONTRACT_ID: "CABCDEF",
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    PACTLY_ROUNDTRIP_NOTE: 'quoted "words" and a trailing backslash \\',
  };
  const dir = mkdtempSync(join(tmpdir(), "pactly-env-lines-"));
  const file = join(dir, "roundtrip.env");
  writeFileSync(file, `${shapeEnvLines(values)}\n`);

  process.loadEnvFile(file);

  for (const [key, expected] of Object.entries(values)) {
    assert.equal(process.env[key], expected, `${key} did not round-trip`);
  }
});
