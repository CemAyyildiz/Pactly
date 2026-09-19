/**
 * Story 3.6's own env fixture, alongside `testConfigEnv.ts`: everything
 * that one sets, plus two admin wallets in `PACTLY_ADMIN_WALLETS` --
 * `DISPUTE_RESOLVER_ADMIN_WALLET` (also `TRUSTLESS_WORK_PLATFORM_ADDRESS`,
 * so it is *both* an admin and Pactly's own dispute resolver) and
 * `NON_RESOLVER_ADMIN_WALLET` (an admin, but not the resolver -- the
 * `403 NOT_DISPUTE_RESOLVER` case). Both are exported so a test file can
 * sign in as either without guessing a value this file alone knows.
 *
 * Same import discipline as `testConfigEnv.ts`: a bare
 * `import "./testConfigEnvAdmin.js";`, as the very first import, in any
 * test file that needs a real admin wallet configured (`app.ts`'s
 * `/admin/...` routes) -- `node --test` runs each test file in its own
 * process, so this never collides with `testConfigEnv.ts`'s own (admin-less)
 * fixture used elsewhere.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

export const DISPUTE_RESOLVER_ADMIN_WALLET = Keypair.random().publicKey();
export const NON_RESOLVER_ADMIN_WALLET = Keypair.random().publicKey();

const envFile = join(mkdtempSync(join(tmpdir(), "pactly-test-admin-config-")), "fixture.env");
writeFileSync(
  envFile,
  [
    "BACKEND_PORT=3001",
    'STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"',
    "SOROBAN_RPC_URL=https://soroban-testnet.stellar.org",
    "ANCHOR_HOME_DOMAIN=tr-mock-anchor.fly.dev",
    "PACTLY_HOME_DOMAIN=pactly.test",
    "PACTLY_AUTH_SIGNING_SECRET=test-signing-secret-not-for-production-use",
    "ESCROW_CONTRACT_ID=",
    `PACTLY_ADMIN_WALLETS=${DISPUTE_RESOLVER_ADMIN_WALLET},${NON_RESOLVER_ADMIN_WALLET}`,
    "TRUSTLESS_WORK_API_URL=",
    "TRUSTLESS_WORK_API_KEY=",
    "TRUSTLESS_WORK_PLATFORM_ID=",
    `TRUSTLESS_WORK_PLATFORM_ADDRESS=${DISPUTE_RESOLVER_ADMIN_WALLET}`,
    "DATABASE_PATH=./data/pactly-test-admin.db",
    "",
  ].join("\n"),
);
process.env.PACTLY_ENV_FILE = envFile;
