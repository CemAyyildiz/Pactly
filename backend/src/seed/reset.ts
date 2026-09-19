/**
 * `npm run demo:reset` (Story 3.8) -- a rehearsal's "start from nothing"
 * button: delete the SQLite file at `config.databasePath` (and any
 * `-wal`/`-shm`/`-journal` siblings a prior run left behind), reopen it
 * (which migrates on open, see `db/client.ts`), reseed it with
 * `seedDemoData` (the same dataset and upsert logic `seed:demo` uses, see
 * `demoData.ts`), then print the seeded providers' profile links and which
 * wallets the demo expects to be configured, so a presenter can tell before
 * rehearsing whether the resolve step will actually work.
 *
 * A missing database file (nothing to delete) is not an error -- deleting
 * is best-effort per candidate path. Running this twice in a row leaves the
 * same seeded rows both times: `seedDemoData` itself is idempotent, and a
 * fresh delete-then-recreate on top of that only ever produces one
 * consistent starting point, never a partial or duplicated one.
 *
 * `resetDemoDatabase` takes an explicit `databasePath` (defaulting to
 * `config.databasePath`) purely so a test can point it at a throwaway file
 * instead of the real dev database.
 */
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { config } from "../config.js";
import { openDatabase, closeDatabase } from "../db/client.js";
import { DEMO_PROVIDERS, seedDemoData } from "./demoData.js";

/** The frontend dev server's fixed port (`frontend/vite.config.ts`) -- the
 * only value that varies is which provider id follows it, so this is not
 * worth a config entry of its own. */
const FRONTEND_ORIGIN = "http://localhost:5173";

/** better-sqlite3's own on-disk siblings for a single logical database
 * file -- deleting only the base path would leave stale WAL/journal
 * fragments behind if a prior process ever switched journal modes.
 *
 * A candidate that exists but cannot actually be removed (it is a
 * directory, or permissions refuse it) throws a plain, single-line message
 * naming the path -- never `rmSync`'s own raw native error/stack, per the
 * spec's "never a stack trace" discipline. */
function deleteDatabaseFile(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = `${databasePath}${suffix}`;
    if (!existsSync(candidate)) continue;
    try {
      rmSync(candidate);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not remove "${candidate}" before reseeding: ${reason}`);
    }
  }
}

export interface ResetDemoDatabaseResult {
  /** One `/providers/:id` link per seeded sample provider, in `demoData.ts`'s
   * own `DEMO_PROVIDERS` order. */
  providerLinks: string[];
}

export async function resetDemoDatabase(databasePath: string = config.databasePath): Promise<ResetDemoDatabaseResult> {
  deleteDatabaseFile(databasePath);
  const { db, sqlite } = openDatabase(databasePath);
  try {
    await seedDemoData(db, "[demo:reset]");
  } finally {
    closeDatabase({ db, sqlite });
  }
  return {
    providerLinks: DEMO_PROVIDERS.map((provider) => `${FRONTEND_ORIGIN}/providers/${provider.id}`),
  };
}

/** Formats one wallet-expectation line for the printed report -- the exact
 * env var name plus whichever value is currently set, or a plain "not set"
 * rather than an empty string that reads like a copy/paste mistake. */
function describeWallet(name: string, value: string): string {
  return `  ${name} = ${value || "(not set)"}`;
}

async function main(): Promise<void> {
  const { providerLinks } = await resetDemoDatabase();

  console.log("[demo:reset] done -- seeded provider links:");
  for (const link of providerLinks) {
    console.log(`  ${link}`);
  }

  console.log("[demo:reset] wallets the demo expects:");
  console.log(describeWallet("SEED_PROVIDER_WALLET", process.env.SEED_PROVIDER_WALLET ?? ""));
  console.log(describeWallet("SEED_ADMIN_WALLET", process.env.SEED_ADMIN_WALLET ?? ""));
  console.log(describeWallet("PACTLY_ADMIN_WALLETS", config.adminWallets.join(",")));
  console.log(describeWallet("TRUSTLESS_WORK_PLATFORM_ADDRESS", config.trustlessWorkPlatformAddress));
  if (!config.trustlessWorkApiUrl || !config.trustlessWorkApiKey || !config.trustlessWorkPlatformAddress) {
    console.log(
      "[demo:reset] Trustless Work variables are incomplete -- discovery, profiles and holding a slot still work; " +
        "locking, funding, completing, releasing and resolving a deposit will 503 ESCROW_UNAVAILABLE until " +
        "TRUSTLESS_WORK_API_URL, TRUSTLESS_WORK_API_KEY and TRUSTLESS_WORK_PLATFORM_ADDRESS are all set (see .env.example).",
    );
  }

  // The database file just got deleted and recreated on disk -- a backend
  // process already running from `npm run dev` still has the *old* file
  // open and keeps serving/writing to it, so the fresh seed never appears
  // until that process reopens the new one.
  console.log("[demo:reset] if `npm run dev` is already running, restart the backend so it picks up the fresh database.");
}

/** Whether this module is being run directly (`tsx src/seed/reset.ts`), as
 * opposed to imported for `resetDemoDatabase` (every test does this, and
 * must never trigger `main()`'s side effects against the real
 * `config.databasePath`). Compares real filesystem paths via
 * `fileURLToPath` rather than hand-building a `file://` URL from
 * `process.argv[1]`, which breaks for a path containing a space or a
 * non-ASCII character (URL-encoding rules would apply to one side and not
 * the other). */
const isCliEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  main()
    .then(() => {
      console.log("[demo:reset] ready");
    })
    .catch((error) => {
      // A plain message, never the raw error/stack (the spec's "never a
      // stack trace" discipline) -- this is a presenter-facing CLI, not a
      // debug log.
      console.error(`[demo:reset] failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
