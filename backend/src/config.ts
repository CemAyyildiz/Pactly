import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The single place where environment variables are read (see ARCHITECTURE-SPINE.md,
 * "Configuration"). Every other module imports `config` from here and never touches
 * `process.env` directly.
 *
 * Values come from the process environment, or from the repository-root `.env` file
 * when one exists. Variables already set in the environment win over the file.
 * `PACTLY_ENV_FILE` points at a different file instead (tests use it to stay isolated
 * from a developer's real `.env`).
 */

// backend/src/config.ts and backend/dist/config.js both sit one level below backend/.
const backendDir = fileURLToPath(new URL("../", import.meta.url));
const envFile = process.env.PACTLY_ENV_FILE ?? resolve(backendDir, "../.env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A variable that must be set to a non-empty value. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value.trim();
}

/**
 * A variable that must be declared but may be empty, because its value only exists
 * after a later setup step (for example the contract id, written by Story 1.7).
 */
function declared(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new ConfigError(
      `Missing required environment variable ${name} (see .env.example; it may be empty for now)`,
    );
  }
  return value.trim();
}

function port(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`Environment variable ${name} must be a TCP port, got "${raw}"`);
  }
  return value;
}

function list(name: string): string[] {
  return declared(name)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function databasePath(name: string): string {
  const value = required(name);
  return isAbsolute(value) ? value : resolve(backendDir, value);
}

export interface Config {
  backendPort: number;
  stellarNetworkPassphrase: string;
  sorobanRpcUrl: string;
  anchorHomeDomain: string;
  /** Empty until the escrow contract is deployed (Story 1.7). */
  escrowContractId: string;
  /** Stellar account ids granted the `admin` role (AD-12). */
  adminWallets: string[];
  /** Absolute path; a relative DATABASE_PATH is resolved against backend/. */
  databasePath: string;
}

function loadConfig(): Config {
  return {
    backendPort: port("BACKEND_PORT"),
    stellarNetworkPassphrase: required("STELLAR_NETWORK_PASSPHRASE"),
    sorobanRpcUrl: required("SOROBAN_RPC_URL"),
    anchorHomeDomain: required("ANCHOR_HOME_DOMAIN"),
    escrowContractId: declared("ESCROW_CONTRACT_ID"),
    adminWallets: list("PACTLY_ADMIN_WALLETS"),
    databasePath: databasePath("DATABASE_PATH"),
  };
}

/** Refuse to start half-configured: name the offending variable and exit. */
function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[config] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

export const config: Config = loadConfigOrExit();
