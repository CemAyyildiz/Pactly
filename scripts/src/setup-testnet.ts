/**
 * `npm run setup:testnet` — resolves the anchor's USDC asset, funds the demo
 * accounts, adds their trustlines, deploys the escrow contract, and prints the
 * result as `.env` lines. Every step is a thin wrapper: the decision of
 * whether to act is made by the pure helpers in `decisions.ts`, `toml.ts` and
 * `env-lines.ts`, which is what makes this file safe to re-run.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Asset } from "@stellar/stellar-sdk";

import { type FetchLike, resolveAnchorUsdcAsset } from "./anchor.js";
import { buildContract, deployContract, detectStellarCli } from "./cli.js";
import {
  assertTestnetPassphrase,
  decideDeployAction,
  decideFriendbotAction,
  decideTrustlineAction,
  hasTrustline,
} from "./decisions.js";
import {
  DEMO_ROLES,
  type DemoRole,
  resolveDemoKeypair,
  secretEnvVar,
  TRUSTLINE_ROLES,
  unionAdminWallets,
} from "./demo-accounts.js";
import { shapeEnvLines } from "./env-lines.js";
import {
  addTrustline,
  type FriendbotCall,
  fundViaFriendbot,
  horizonServer,
  type LoadAccount,
  loadAccountWithRetry,
  type SubmitTransaction,
} from "./horizon.js";

// scripts/src/setup-testnet.ts -> scripts/ -> repository root.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const envPath = resolve(repoRoot, ".env");

class SetupError extends Error {}

/** The exact `.env` keys a successful run must have resolved — every demo
 * role's secret, plus the admin wallet list and the contract id. Exported so
 * both the check below and the success path that calls it are testable: a
 * key that stops getting assigned (e.g. a deleted line) is a missing key
 * here, not a silently incomplete printed block. */
export const REQUIRED_ENV_LINE_KEYS: readonly string[] = [
  ...DEMO_ROLES.map(secretEnvVar),
  "PACTLY_ADMIN_WALLETS",
  "ESCROW_CONTRACT_ID",
];

/** Throws naming whatever `requiredKeys` (default {@link REQUIRED_ENV_LINE_KEYS})
 * is missing from `envLines`. Call this on the success path, before printing —
 * a run that finished without resolving everything it should have must fail
 * loudly rather than ship an incomplete `.env` block. */
export function assertCompleteEnvLines(
  envLines: Record<string, string>,
  requiredKeys: readonly string[] = REQUIRED_ENV_LINE_KEYS,
): void {
  const missing = requiredKeys.filter((key) => !(key in envLines));
  if (missing.length > 0) {
    throw new SetupError(
      `Internal error: setup:testnet finished without resolving ${missing.join(", ")}. This is a bug in setup-testnet.ts, not a network or configuration problem.`,
    );
  }
}

function log(message: string): void {
  // Progress goes to stderr so stdout stays exactly the `.env` lines this
  // command promises — "ready to paste or redirect".
  console.error(`[setup:testnet] ${message}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new SetupError(`Missing ${name}. Copy .env.example to .env at the repository root first.`);
  }
  return value.trim();
}

/**
 * Everything below shells out to the network, Horizon, or the Stellar CLI
 * through a seam that already exists on the function it calls (see
 * `anchor.ts`, `horizon.ts`, `cli.ts`). `SetupTestnetDeps` bundles those same
 * seams in one place purely so a test can run the whole flow — including the
 * exact line that resolves `PACTLY_ADMIN_WALLETS` — against fakes instead of
 * the network. Every field is optional: leaving one out is `undefined`,
 * which is exactly what a real, unattended run passes, so it falls through
 * to that function's own real default. Nothing here changes real behaviour.
 */
export interface SetupTestnetDeps {
  loadEnvFile: () => void;
  fetchAnchorToml: FetchLike;
  loadAccount: LoadAccount;
  friendbotCall: FriendbotCall;
  submitTransaction: SubmitTransaction;
  cliProbe: () => void;
}

function defaultLoadEnvFile(): void {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

export async function runSetupTestnet(deps: Partial<SetupTestnetDeps> = {}): Promise<void> {
  (deps.loadEnvFile ?? defaultLoadEnvFile)();

  const anchorHomeDomain = requireEnv("ANCHOR_HOME_DOMAIN");
  const networkPassphrase = requireEnv("STELLAR_NETWORK_PASSPHRASE");
  const sorobanRpcUrl = requireEnv("SOROBAN_RPC_URL");
  assertTestnetPassphrase(networkPassphrase);

  log(`Resolving the USDC asset from ${anchorHomeDomain}'s stellar.toml...`);
  const usdcAsset = await resolveAnchorUsdcAsset(anchorHomeDomain, deps.fetchAnchorToml);
  log(`USDC asset: ${usdcAsset.code}:${usdcAsset.issuer}`);
  const asset = new Asset(usdcAsset.code, usdcAsset.issuer);

  const server = horizonServer();
  // Whatever resolves into this goes out on every exit path — success or
  // failure — via the `finally` block below, so a funded account whose
  // secret was already generated is never left unprintable just because a
  // later step throws.
  const envLines: Record<string, string> = {};
  let failed = false;

  try {
    const keypairsByRole = new Map<DemoRole, ReturnType<typeof resolveDemoKeypair>>();

    for (const role of DEMO_ROLES) {
      const envVarName = secretEnvVar(role);
      const resolved = resolveDemoKeypair(process.env[envVarName], envVarName);
      keypairsByRole.set(role, resolved);
      envLines[envVarName] = resolved.keypair.secret();

      const publicKey = resolved.keypair.publicKey();
      log(`${role} (${publicKey})${resolved.isNew ? " — newly generated" : " — from .env"}`);

      let account = await loadAccountWithRetry(server, publicKey, undefined, undefined, deps.loadAccount);
      const fundingAction = decideFriendbotAction(account !== undefined);
      if (fundingAction === "run") {
        log(`${role}: funding via friendbot...`);
        await fundViaFriendbot(server, publicKey, deps.friendbotCall);
        account = await loadAccountWithRetry(server, publicKey, undefined, undefined, deps.loadAccount);
      }
      if (!account) {
        throw new SetupError(
          `${role}: friendbot reported success but the account still cannot be loaded from Horizon after several retries.`,
        );
      }
      log(fundingAction === "run" ? `${role}: funded.` : `${role}: already funded, skipping.`);

      if (TRUSTLINE_ROLES.includes(role)) {
        const trustlineAction = decideTrustlineAction(
          hasTrustline(account.balances, usdcAsset.code, usdcAsset.issuer),
        );
        if (trustlineAction === "run") {
          log(`${role}: adding the USDC trustline...`);
          await addTrustline(server, account, resolved.keypair, asset, networkPassphrase, deps.submitTransaction);
          log(`${role}: trustline added.`);
        } else {
          log(`${role}: USDC trustline already present, skipping.`);
        }
      }
    }

    const admin = keypairsByRole.get("admin");
    if (!admin) {
      throw new SetupError("admin keypair was not resolved; this is a bug in DEMO_ROLES.");
    }
    envLines.PACTLY_ADMIN_WALLETS = unionAdminWallets(process.env.PACTLY_ADMIN_WALLETS, admin.keypair.publicKey());

    const deployDecision = decideDeployAction(process.env.ESCROW_CONTRACT_ID);
    if (deployDecision.action === "skip") {
      log(`Escrow contract already deployed: ${deployDecision.contractId}, skipping.`);
      envLines.ESCROW_CONTRACT_ID = deployDecision.contractId;
    } else {
      // Only the branch that actually deploys needs the CLI — a run whose
      // work is already done must not abort on a machine without it.
      log("Checking for the Stellar CLI...");
      detectStellarCli(deps.cliProbe);
      log("Stellar CLI found.");

      log("Building the escrow contract...");
      const wasmPath = buildContract();
      log(`Deploying ${wasmPath}...`);
      const contractId = deployContract({
        wasmPath,
        sourceSecret: admin.keypair.secret(),
        rpcUrl: sorobanRpcUrl,
        networkPassphrase,
      });
      log(`Escrow contract deployed: ${contractId}`);
      envLines.ESCROW_CONTRACT_ID = contractId;
    }

    // The success path's own gate: printed output must carry every key it
    // promised, not merely whatever happened to get assigned.
    assertCompleteEnvLines(envLines);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (Object.keys(envLines).length > 0) {
      log(
        failed
          ? "Stopped before finishing — printing what resolved so far so no funded account is orphaned:"
          : "Done. Paste the following into .env:",
      );
      console.log(shapeEnvLines(envLines));
    }
  }
}

// Only run when this file is the process entry point — not when a test
// imports it for `runSetupTestnet`/`assertCompleteEnvLines`/
// `REQUIRED_ENV_LINE_KEYS`, which must not trigger a real run (network
// calls, reading the real `.env`, ...).
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  runSetupTestnet().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[setup:testnet] ${message}`);
    process.exitCode = 1;
  });
}
