import assert from "node:assert/strict";
import { test } from "node:test";

import { deployContract, DeployError, detectStellarCli, parseContractId, StellarCliMissingError } from "../src/cli.js";

test("detectStellarCli throws naming the install page when the probe fails", () => {
  assert.throws(
    () =>
      detectStellarCli(() => {
        throw new Error("command not found: stellar");
      }),
    (error: unknown) =>
      error instanceof StellarCliMissingError &&
      error.message.includes("https://developers.stellar.org/docs/tools/cli/install-cli"),
  );
});

test("detectStellarCli does not throw when the probe succeeds", () => {
  assert.doesNotThrow(() => detectStellarCli(() => {}));
});

const VALID_ID_A = `C${"A".repeat(55)}`;
const VALID_ID_B = `C${"B".repeat(55)}`;

test("parseContractId accepts the last output line when it is a full contract id", () => {
  assert.equal(parseContractId(`Deploying...\n${VALID_ID_A}\n`), VALID_ID_A);
});

test("parseContractId ignores diagnostic lines and a trailing newline", () => {
  assert.equal(parseContractId(`Uploading wasm...\nSimulating transaction...\n${VALID_ID_B}\n\n`), VALID_ID_B);
});

test("parseContractId rejects output that does not end in a full contract id", () => {
  assert.throws(() => parseContractId("Deploying...\nerror: something went wrong"), /did not return a contract id/);
});

test("parseContractId rejects a line that merely starts with C but is the wrong shape", () => {
  // A mutation from `.pop()` to `.shift()`, or from a full match to a `startsWith("C")`
  // check, must fail this: neither "Contract deployed" nor a too-short id is valid.
  assert.throws(() => parseContractId("Contract deployed\nC123"), /did not return a contract id/);
});

test("deployContract's failure message does not echo the deploying secret", () => {
  const secret = "SVERYSECRETVALUETHATMUSTNEVERAPPEARINANYMESSAGE";
  assert.throws(
    () =>
      deployContract({
        wasmPath: "/nonexistent/contract.wasm",
        sourceSecret: secret,
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      }),
    (error: unknown) => error instanceof DeployError && !error.message.includes(secret),
  );
});
