/**
 * `npm run -w backend seed:demo` -- idempotent demo data so both Story 3.1
 * screens (the public profile and the provider's availability panel) can
 * be opened in a browser immediately, per the story's own Design Notes
 * ("Why a seed script now"). The dataset and upsert logic live in
 * `demoData.ts` (Story 3.8 pulled them out so `reset.ts`'s `demo:reset`
 * reuses them exactly); this file is just the CLI entry point: open
 * `config.databasePath` (which migrates on open, see `db/client.ts`), seed
 * it, close it.
 *
 * `SEED_PROVIDER_WALLET=G...` and `SEED_ADMIN_WALLET=G...` are read
 * directly from `process.env` inside `seedDemoData` (not `config.ts` --
 * these are seed-only knobs, not values the running app ever needs).
 */
import { openDatabase, closeDatabase } from "../db/client.js";
import { config } from "../config.js";
import { seedDemoData } from "./demoData.js";

async function seed(): Promise<void> {
  const { db, sqlite } = openDatabase(config.databasePath);
  try {
    await seedDemoData(db);
  } finally {
    closeDatabase({ db, sqlite });
  }
}

seed()
  .then(() => {
    console.log("[seed:demo] done");
  })
  .catch((error) => {
    console.error("[seed:demo] failed", error);
    process.exitCode = 1;
  });
