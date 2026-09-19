/**
 * The "is this already done?" decisions that make every setup step idempotent.
 * Each function takes the state a network call already fetched and decides what
 * to do next; none of them touch the network themselves. This is what a
 * second run reads to skip work instead of failing on it.
 */
import { Networks } from "@stellar/stellar-sdk";
import type { Horizon } from "@stellar/stellar-sdk";

import { CONTRACT_ID_PATTERN } from "./cli.js";

export type StepAction = "skip" | "run";

/** An account already funded (it can be loaded) needs no friendbot call. */
export function decideFriendbotAction(accountExists: boolean): StepAction {
  return accountExists ? "skip" : "run";
}

/** A trustline already on the account needs no `changeTrust` operation. */
export function decideTrustlineAction(trustlineExists: boolean): StepAction {
  return trustlineExists ? "skip" : "run";
}

export type DeployDecision = { action: "skip"; contractId: string } | { action: "run" };

/**
 * A non-empty `ESCROW_CONTRACT_ID` already in the environment (typically loaded
 * from `.env`) means a previous run already deployed — reuse it instead of
 * deploying again. Validated against the same shape a freshly deployed id
 * must have, so a stale or truncated value is refused rather than re-printed
 * as though it were still good.
 */
export function decideDeployAction(existingContractId: string | undefined): DeployDecision {
  const trimmed = existingContractId?.trim();
  if (!trimmed) {
    return { action: "run" };
  }
  if (!CONTRACT_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `ESCROW_CONTRACT_ID is set to "${trimmed}", which is not a valid contract id (expected "C" followed ` +
        "by 55 base32 characters). Fix or clear it in .env and re-run.",
    );
  }
  return { action: "skip", contractId: trimmed };
}

/** Throws unless `passphrase` is exactly the testnet passphrase — this command
 * only ever targets testnet, deliberately, and never falls back to mainnet. */
export function assertTestnetPassphrase(passphrase: string): void {
  if (passphrase !== Networks.TESTNET) {
    throw new Error(
      `STELLAR_NETWORK_PASSPHRASE is "${passphrase}", not the testnet passphrase. ` +
        "This command only ever targets testnet.",
    );
  }
}

/** True when `balances` already carries a trustline for `assetCode`/`assetIssuer`. */
export function hasTrustline(
  balances: readonly Horizon.HorizonApi.BalanceLine[],
  assetCode: string,
  assetIssuer: string,
): boolean {
  return balances.some(
    (balance) =>
      "asset_code" in balance &&
      "asset_issuer" in balance &&
      balance.asset_code === assetCode &&
      balance.asset_issuer === assetIssuer,
  );
}
