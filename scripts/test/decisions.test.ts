import assert from "node:assert/strict";
import { test } from "node:test";

import { Networks } from "@stellar/stellar-sdk";
import type { Horizon } from "@stellar/stellar-sdk";

import {
  assertTestnetPassphrase,
  decideDeployAction,
  decideFriendbotAction,
  decideTrustlineAction,
  hasTrustline,
} from "../src/decisions.js";

const VALID_CONTRACT_ID = `C${"A".repeat(55)}`;

test("decideFriendbotAction skips a funded account", () => {
  assert.equal(decideFriendbotAction(true), "skip");
});

test("decideFriendbotAction funds an account that does not exist yet", () => {
  assert.equal(decideFriendbotAction(false), "run");
});

test("decideTrustlineAction skips a trustline that is already there", () => {
  assert.equal(decideTrustlineAction(true), "skip");
});

test("decideTrustlineAction adds a trustline that is missing", () => {
  assert.equal(decideTrustlineAction(false), "run");
});

test("decideDeployAction reuses a contract id already in the environment", () => {
  assert.deepEqual(decideDeployAction(VALID_CONTRACT_ID), { action: "skip", contractId: VALID_CONTRACT_ID });
});

test("decideDeployAction trims whitespace around a reused contract id", () => {
  assert.deepEqual(decideDeployAction(`  ${VALID_CONTRACT_ID}  `), { action: "skip", contractId: VALID_CONTRACT_ID });
});

test("decideDeployAction deploys when there is no contract id yet", () => {
  assert.deepEqual(decideDeployAction(undefined), { action: "run" });
});

test("decideDeployAction deploys when the contract id is blank", () => {
  assert.deepEqual(decideDeployAction("   "), { action: "run" });
});

test("decideDeployAction refuses a stale or truncated contract id rather than re-printing it", () => {
  assert.throws(() => decideDeployAction("CABCDEF"), /not a valid contract id/);
});

test("assertTestnetPassphrase accepts the testnet passphrase", () => {
  assert.doesNotThrow(() => assertTestnetPassphrase(Networks.TESTNET));
});

test("assertTestnetPassphrase rejects anything else, naming what was given", () => {
  assert.throws(
    () => assertTestnetPassphrase("Public Global Stellar Network ; September 2015"),
    /not the testnet passphrase/,
  );
});

const ISSUER = "GUSDCISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

// No `as` cast: the object literal is checked against the declared return
// type directly, so a field that doesn't belong on `BalanceLineAsset` (or a
// missing required one) is a typecheck error, not silently accepted.
function balanceLine(overrides: Partial<Horizon.HorizonApi.BalanceLineAsset> = {}): Horizon.HorizonApi.BalanceLineAsset {
  return {
    balance: "0",
    limit: "922337203685.4775807",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: ISSUER,
    buying_liabilities: "0",
    selling_liabilities: "0",
    last_modified_ledger: 1,
    is_authorized: true,
    is_authorized_to_maintain_liabilities: true,
    is_clawback_enabled: false,
    ...overrides,
  };
}

const NATIVE_BALANCE: Horizon.HorizonApi.BalanceLine = {
  balance: "100",
  asset_type: "native",
  buying_liabilities: "0",
  selling_liabilities: "0",
};

test("hasTrustline is true when a balance matches the asset code and issuer", () => {
  assert.equal(hasTrustline([NATIVE_BALANCE, balanceLine({})], "USDC", ISSUER), true);
});

test("hasTrustline is false when only the native balance is present", () => {
  assert.equal(hasTrustline([NATIVE_BALANCE], "USDC", ISSUER), false);
});

test("hasTrustline is false when the code matches but the issuer does not", () => {
  assert.equal(
    hasTrustline([balanceLine({ asset_issuer: "GOTHERISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" })], "USDC", ISSUER),
    false,
  );
});

test("hasTrustline is false for an empty balances list", () => {
  assert.equal(hasTrustline([], "USDC", ISSUER), false);
});
