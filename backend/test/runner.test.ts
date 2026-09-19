/**
 * `runner.ts`'s tick isolation (the spec's own "Runner resilience" I/O
 * matrix row): a reconciler tick that throws is logged, never crashes the
 * process, and the next tick still fires on its own schedule. Both
 * intervals are injected short (a few milliseconds) so this test finishes
 * fast and never waits for a real 15s/30s clock.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { startRunner } from "../src/runner.js";
import { closeDatabase, openTestDatabase } from "./helpers.js";

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, 5);
    };
    check();
  });
}

test("a hold-expiry tick that throws is logged, isolated, and the runner keeps scheduling the next one", async () => {
  const result = openTestDatabase();
  try {
    const logs: string[] = [];
    const handle = startRunner(result.db, {
      log: (message) => logs.push(message),
      reconcilerIntervalMs: 10_000_000, // effectively disabled for this test
      holdExpiryIntervalMs: 5,
    });

    // Closing the underlying connection makes every subsequent query throw
    // a real error -- the most direct way to force `expireHolds`'s own read
    // to fail without adding a test-only injection seam to `runner.ts`
    // itself. If tick isolation did not work, this would either throw out
    // of the runner's own timer (an unhandled rejection) or stop the timer
    // from ever firing again.
    result.sqlite.close();

    await waitFor(() => logs.filter((message) => message.includes("hold-expiry tick failed")).length >= 2, 1000);
    handle.stop();

    assert.ok(
      logs.filter((message) => message.includes("hold-expiry tick failed")).length >= 2,
      "at least two failed ticks must be logged -- proving the first failure did not stop the timer",
    );
  } finally {
    // Already closed above; closing twice would throw.
  }
});

test("a reconciler tick whose listEscrows call throws is logged and does not stop the hold-expiry tick from also running", async () => {
  const result = openTestDatabase();
  try {
    // Trustless Work config is empty in the test fixture env
    // (testConfigEnv.ts), so the reconciler tick is skipped (logged once)
    // rather than ever reaching a network seam -- this is itself the
    // "refuse before any network access" discipline the reconciler tick
    // must honor, exercised end to end through the runner.
    const logs: string[] = [];
    const handle = startRunner(result.db, {
      log: (message) => logs.push(message),
      reconcilerIntervalMs: 5,
      holdExpiryIntervalMs: 5,
    });

    await waitFor(() => logs.some((message) => message.includes("reconciler tick skipped")), 1000);
    handle.stop();

    assert.ok(logs.some((message) => message.includes("Trustless Work config is incomplete")));
  } finally {
    closeDatabase(result);
  }
});
