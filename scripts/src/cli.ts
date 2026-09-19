/**
 * Everything that shells out to the Stellar CLI: detecting it, building the
 * contract's wasm artifact, and deploying it. `scripts/README.md` already
 * commits to the Stellar CLI as the deploy mechanism (AC).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/src/cli.ts -> scripts/ -> repository root.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractManifest = resolve(repoRoot, "contracts/escrow/Cargo.toml");
const wasmPath = resolve(repoRoot, "contracts/escrow/target/wasm32v1-none/release/pactly_escrow.wasm");

export class StellarCliMissingError extends Error {
  constructor() {
    super(
      "Stellar CLI not found on PATH. Install it from " +
        "https://developers.stellar.org/docs/tools/cli/install-cli and try again.",
    );
  }
}

export class CargoBuildError extends Error {}

function runStellarVersionProbe(): void {
  execFileSync("stellar", ["--version"], { stdio: "ignore" });
}

/**
 * Throws {@link StellarCliMissingError} when `stellar` is not on PATH. `probe`
 * defaults to actually shelling out; a test can pass one that throws (or
 * doesn't) to exercise both branches deterministically, independent of
 * whether the CLI happens to be installed on the machine running the test.
 */
export function detectStellarCli(probe: () => void = runStellarVersionProbe): void {
  try {
    probe();
  } catch {
    throw new StellarCliMissingError();
  }
}

/**
 * Builds the release wasm the same way `npm run contracts:build` does, so the
 * deploy step never assumes a stale or absent artifact is good enough.
 * Returns the artifact's path.
 */
export function buildContract(): string {
  try {
    execFileSync(
      "cargo",
      ["build", "--manifest-path", contractManifest, "--target", "wasm32v1-none", "--release"],
      { stdio: "inherit" },
    );
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    throw new CargoBuildError(
      code === "ENOENT"
        ? "cargo not found on PATH. Install Rust (https://rustup.rs) and try again."
        : "cargo build failed (see the cargo output above). Make sure the wasm32v1-none " +
            "target is installed (`rustup target add wasm32v1-none`) and try again.",
    );
  }
  if (!existsSync(wasmPath)) {
    throw new CargoBuildError(`cargo build finished but the expected artifact is missing: ${wasmPath}`);
  }
  return wasmPath;
}

export interface DeployParams {
  wasmPath: string;
  /** Pays the deploy transaction's fee; needs no special contract role. */
  sourceSecret: string;
  rpcUrl: string;
  networkPassphrase: string;
}

/** A full, well-formed Stellar contract id: `C` followed by 55 base32 characters. */
export const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/**
 * Picks the contract id out of `stellar contract deploy`'s stdout. The CLI
 * writes progress/diagnostics to stderr and the contract id alone to stdout,
 * but this requires a full match on the last non-empty line rather than
 * merely a `C` prefix, so a diagnostic line can never be mistaken for one.
 */
export function parseContractId(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidate = lines.at(-1);
  if (!candidate || !CONTRACT_ID_PATTERN.test(candidate)) {
    throw new Error(
      "Stellar CLI did not return a contract id on its last output line. " +
        "Run `stellar contract deploy` manually with the same wasm and network to see why.",
    );
  }
  return candidate;
}

export class DeployError extends Error {}

/** Deploys the wasm at `params.wasmPath` and returns the new contract id. */
export function deployContract(params: DeployParams): string {
  let output: string;
  try {
    output = execFileSync(
      "stellar",
      [
        "contract",
        "deploy",
        "--wasm",
        params.wasmPath,
        "--rpc-url",
        params.rpcUrl,
        "--network-passphrase",
        params.networkPassphrase,
      ],
      {
        encoding: "utf8",
        // The deploying account's secret goes through the environment, never
        // argv: an argv value is visible to every other process on the
        // machine for the life of the child (e.g. `ps`), and a failed
        // execFileSync call embeds the full argv in its own error message —
        // which this command would otherwise print to stderr.
        env: { ...process.env, STELLAR_SECRET_KEY: params.sourceSecret },
      },
    );
  } catch {
    // Deliberately not the caught error's own message: execFileSync's
    // failure embeds the full argv and env is not included, but nothing
    // here should risk echoing anything secret-shaped into an error an
    // operator might paste into a bug report or a log file.
    throw new DeployError(
      `stellar contract deploy failed. Check that ${params.rpcUrl} is reachable and the ` +
        "deploying account is funded, then run `stellar contract deploy` manually to see the CLI's own output.",
    );
  }
  return parseContractId(output);
}
