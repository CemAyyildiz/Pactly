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

/** A variable that may be absent or empty, falling back to `fallback` --
 * for the passkey/custodial-account knobs (see `.env.example`), every one
 * of which has a local-dev default so an existing `.env` (and every test
 * fixture's temp env file) keeps working without being touched. */
function optional(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value.trim();
}

/** {@link optional}, split on commas like {@link list}. */
function optionalList(name: string, fallback: string): string[] {
  return optional(name, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function databasePath(name: string): string {
  const value = required(name);
  return isAbsolute(value) ? value : resolve(backendDir, value);
}

/** Same as {@link required}, plus a minimum length -- for a secret this
 * codebase derives cryptographic key material from directly (both the
 * Pactly JWT's HMAC key and its own SEP-10 server keypair; see
 * `auth/challenge.ts`), a short value is a full authentication bypass on
 * both, not merely a weak one. 32 characters is a reasonable floor for an
 * HMAC-256 key. */
function secret(name: string, minLength: number): string {
  const value = required(name);
  if (value.length < minLength) {
    throw new ConfigError(`Environment variable ${name} must be at least ${minLength} characters long`);
  }
  return value;
}

export interface Config {
  backendPort: number;
  stellarNetworkPassphrase: string;
  sorobanRpcUrl: string;
  anchorHomeDomain: string;
  /** The domain Pactly's own SEP-10-shaped challenge is issued under (AD-5)
   * -- never the anchor's home domain, which is `anchorHomeDomain` above. */
  pactlyHomeDomain: string;
  /** Signs Pactly's own JWT (via `jose`) and, domain-separated, derives the
   * server keypair Pactly's own challenge is issued and verified under (see
   * `auth/challenge.ts`). Never the anchor's key. */
  pactlyAuthSigningSecret: string;
  /** Empty until the escrow contract is deployed (Story 1.7). */
  escrowContractId: string;
  /** Stellar account ids granted the `admin` role (AD-12). */
  adminWallets: string[];
  /** Trustless Work's Core v2 API base URL (Story 2.6). Empty until Story
   * 1.8's blocked live ACs are unblocked with a real operator key -- the
   * adapter refuses before any network access when this is empty, same
   * discipline as `escrowContractId` above. */
  trustlessWorkApiUrl: string;
  /** `x-api-key` header value for the Trustless Work API. Empty until a
   * real operator key exists. */
  trustlessWorkApiKey: string;
  /** Attribution header value (`X-TW-Platform`) identifying Pactly to
   * Trustless Work -- provided by the operator's TW account, not invented
   * here. May be empty (the adapter omits the header rather than sending
   * one that is blank). */
  trustlessWorkPlatformId: string;
  /** Pactly's own Stellar account (G...) used for every Trustless Work
   * role Pactly itself holds: platform, dispute resolver, and (Story 2.6's
   * own admin-role decision -- see `escrow/trustless-work/client.ts`)
   * admin. Signing itself is out of this story's scope; only the address
   * is needed to build unsigned XDR naming Pactly correctly. */
  trustlessWorkPlatformAddress: string;
  /** Absolute path; a relative DATABASE_PATH is resolved against backend/. */
  databasePath: string;
  /** Passkey pivot: the key material every custodial account secret is
   * encrypted under (`custodial/keys.ts`, AES-256-GCM; the actual key is a
   * sha256 of this). Empty means "derive from `pactlyAuthSigningSecret`
   * under a fixed prefix" so local dev keeps working with no new variable
   * -- a real deployment sets its own, so rotating the JWT secret never
   * silently locks every custodial account. */
  custodialEncryptionKey: string;
  /** Testnet friendbot, used once per custodial account to fund it
   * (`custodial/funding.ts`). */
  friendbotUrl: string;
  /** WebAuthn relying-party id -- the frontend's own host (no scheme, no
   * port), `localhost` in dev. */
  passkeyRpId: string;
  /** Every origin a passkey ceremony may be completed from (scheme + host
   * + port) -- `http://localhost:5173` in dev; a comma list is allowed. */
  passkeyRpOrigins: string[];
  /** OpenZeppelin Channels relayer (Passkey Kit). Empty = fee-bump locally. */
  passkeyRelayerBaseUrl: string;
  passkeyRelayerApiKey: string;
}

function loadConfig(): Config {
  return {
    backendPort: port("BACKEND_PORT"),
    stellarNetworkPassphrase: required("STELLAR_NETWORK_PASSPHRASE"),
    sorobanRpcUrl: required("SOROBAN_RPC_URL"),
    anchorHomeDomain: required("ANCHOR_HOME_DOMAIN"),
    pactlyHomeDomain: required("PACTLY_HOME_DOMAIN"),
    pactlyAuthSigningSecret: secret("PACTLY_AUTH_SIGNING_SECRET", 32),
    escrowContractId: declared("ESCROW_CONTRACT_ID"),
    adminWallets: list("PACTLY_ADMIN_WALLETS"),
    trustlessWorkApiUrl: declared("TRUSTLESS_WORK_API_URL"),
    trustlessWorkApiKey: declared("TRUSTLESS_WORK_API_KEY"),
    trustlessWorkPlatformId: declared("TRUSTLESS_WORK_PLATFORM_ID"),
    trustlessWorkPlatformAddress: declared("TRUSTLESS_WORK_PLATFORM_ADDRESS"),
    databasePath: databasePath("DATABASE_PATH"),
    custodialEncryptionKey: optional("PACTLY_CUSTODIAL_ENCRYPTION_KEY", ""),
    friendbotUrl: optional("FRIENDBOT_URL", "https://friendbot.stellar.org"),
    passkeyRpId: optional("PACTLY_RP_ID", "localhost"),
    passkeyRpOrigins: optionalList("PACTLY_RP_ORIGIN", "http://localhost:5173"),
    passkeyRelayerBaseUrl: optional("PASSKEY_RELAYER_BASE_URL", ""),
    passkeyRelayerApiKey: optional("PASSKEY_RELAYER_API_KEY", ""),
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
