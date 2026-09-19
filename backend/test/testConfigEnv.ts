/**
 * A pure side-effect module: points `PACTLY_ENV_FILE` at a self-contained
 * fixture with every variable `backend/src/config.ts` requires, before
 * anything else in an importing test file can trigger `config.ts`'s
 * module-load side effect (it reads env at import time and calls
 * `process.exit(1)` if a required variable is missing).
 *
 * Import this with a bare `import "./testConfigEnv.js";` as the *first*
 * import in any test file that does a value import (not `import type`) of
 * a module under `src/chain/` or `src/services/` -- those transitively
 * import `../config.js`. A static import is hoisted ahead of the rest of
 * the importing file, but sibling static imports still evaluate in source
 * order, so this file's own (dependency-free) top-level code runs and sets
 * the env var before the sibling import that needs it does. An exported
 * *function* would not work here: by the time an importing file's own
 * top-level statements run (including a call to an exported setup
 * function), every one of its own static imports -- config.ts included --
 * has already been evaluated.
 *
 * Not itself a test file (does not match `test/*.test.ts`).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const envFile = join(mkdtempSync(join(tmpdir(), "pactly-test-config-")), "fixture.env");
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
    "PACTLY_ADMIN_WALLETS=",
    "TRUSTLESS_WORK_API_URL=",
    "TRUSTLESS_WORK_API_KEY=",
    "TRUSTLESS_WORK_PLATFORM_ID=",
    "TRUSTLESS_WORK_PLATFORM_ADDRESS=",
    "DATABASE_PATH=./data/pactly-test.db",
    "",
  ].join("\n"),
);
process.env.PACTLY_ENV_FILE = envFile;
