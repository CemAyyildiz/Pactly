/**
 * Story 3.8's `demo:reset` path (`backend/src/seed/reset.ts`): a dirty or
 * missing database file becomes a fresh, migrated, seeded one, and running
 * it twice in a row leaves the same rows -- never duplicates, never a
 * stack trace. Uses a real temporary file (not `openTestDatabase`'s
 * `:memory:`) since deleting the file on disk is exactly the behaviour
 * under test.
 */
import "./testConfigEnv.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { resetDemoDatabase } from "../src/seed/reset.js";
import { DEMO_PROVIDERS } from "../src/seed/demoData.js";
import { openDatabase, closeDatabase } from "../src/db/client.js";
import { listApprovedProviderProfiles } from "../src/db/providerProfiles.js";

function tempDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "pactly-demo-reset-")), "pactly.db");
}

test("resetDemoDatabase recreates a fresh, seeded database from nothing", async () => {
  const databasePath = tempDatabasePath();
  try {
    assert.equal(existsSync(databasePath), false, "sanity: nothing exists yet");

    const { providerLinks } = await resetDemoDatabase(databasePath);

    assert.equal(existsSync(databasePath), true);
    assert.equal(providerLinks.length, DEMO_PROVIDERS.length);
    assert.ok(providerLinks.every((link) => link.startsWith("http://localhost:5173/providers/")));
    for (const provider of DEMO_PROVIDERS) {
      assert.ok(providerLinks.includes(`http://localhost:5173/providers/${provider.id}`));
    }

    const result = openDatabase(databasePath);
    try {
      const approved = await listApprovedProviderProfiles(result.db);
      assert.equal(approved.length, DEMO_PROVIDERS.length, "every seeded sample provider is approved");
    } finally {
      closeDatabase(result);
    }
  } finally {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-journal`, { force: true });
  }
});

test("resetDemoDatabase against a dirty (non-database) file at the path does not error, and leaves a clean seeded database", async () => {
  const databasePath = tempDatabasePath();
  try {
    // A "dirty" starting state: some unrelated file sitting at the same
    // path (simulating a corrupted or stale previous run) -- the spec's
    // own edge case ("Reset on a dirty database"): no error, just deleted
    // and replaced.
    writeFileSync(databasePath, "not a real sqlite file");

    const { providerLinks } = await resetDemoDatabase(databasePath);

    assert.equal(providerLinks.length, DEMO_PROVIDERS.length);
    const result = openDatabase(databasePath);
    try {
      const approved = await listApprovedProviderProfiles(result.db);
      assert.equal(approved.length, DEMO_PROVIDERS.length);
    } finally {
      closeDatabase(result);
    }
  } finally {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-journal`, { force: true });
  }
});

test("resetDemoDatabase run twice in a row is idempotent -- same seeded rows, no duplicates", async () => {
  const databasePath = tempDatabasePath();
  try {
    await resetDemoDatabase(databasePath);
    const { providerLinks: secondLinks } = await resetDemoDatabase(databasePath);

    assert.equal(secondLinks.length, DEMO_PROVIDERS.length);

    const result = openDatabase(databasePath);
    try {
      const approved = await listApprovedProviderProfiles(result.db);
      assert.equal(approved.length, DEMO_PROVIDERS.length, "no duplicate provider rows after a second reset");
      const wallets = approved.map((p) => p.walletAddress);
      assert.equal(new Set(wallets).size, wallets.length, "every wallet address is still unique");
    } finally {
      closeDatabase(result);
    }
  } finally {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-journal`, { force: true });
  }
});
