/**
 * The two long-lived background ticks Story 3.4 needs once a real process
 * is running (never in tests, never inside `createApp`, per the spec's own
 * "Always" rule): the Trustless Work reconciler, and the hold-expiry
 * double-sale detector. `index.ts` is the only caller.
 *
 * Each tick is independent and isolated: a thrown error is logged and the
 * process keeps running -- the next tick still fires on its own schedule
 * (the spec's own "Runner resilience" I/O-matrix row). Neither tick ever
 * overlaps itself; a tick still running when the next one is due simply
 * lets that next one wait, so two reconciler batches (or two hold-expiry
 * sweeps) never run concurrently against the same database.
 */
import { config } from "./config.js";
import type { Db } from "./db/client.js";
import { expireHolds } from "./services/booking.js";
import { realListEscrows, runReconcilerOnce } from "./escrow/trustless-work/reconciler.js";
import type { ListEscrowsParams, ListEscrowsResponse } from "@trustless-work/escrow-js";

const RECONCILER_INTERVAL_MS = 15_000;
const HOLD_EXPIRY_INTERVAL_MS = 30_000;

function defaultLog(message: string): void {
  console.error(message);
}

/** `true` only once every Trustless Work variable the adapter/reconciler
 * need is non-empty -- the reconciler tick is skipped (logged once, not
 * every 15s) until then, the same "refuse before any network access when
 * config is incomplete" discipline `escrow/trustless-work/client.ts` and
 * `reconciler.ts` already enforce at the call level; skipping the tick
 * entirely here just avoids spamming that same refusal on a timer. */
function defaultTrustlessWorkConfigComplete(): boolean {
  return Boolean(config.trustlessWorkApiUrl && config.trustlessWorkApiKey && config.trustlessWorkPlatformAddress);
}

/** Runs `fn`, isolating whatever it throws: logged, never rethrown, so one
 * bad tick can never stop the timer that schedules the next one (let alone
 * crash the process). */
async function runTickIsolated(name: string, fn: () => Promise<void>, log: (message: string) => void): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const reason = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log(`[runner] ${name} tick failed: ${reason}`);
  }
}

export interface StartRunnerOptions {
  log?: (message: string) => void;
  reconcilerIntervalMs?: number;
  holdExpiryIntervalMs?: number;
  /** Overrides the reconciler's own `listEscrows` read seam -- defaults to
   * the real Trustless Work call. A test injects a fake here to exercise a
   * real reconciler tick (moving a booking to `locked`, or throwing) without
   * a live API key. */
  listEscrows?: (params: ListEscrowsParams) => Promise<ListEscrowsResponse>;
  /** Overrides the "is Trustless Work configured" check that decides
   * whether the reconciler tick runs at all -- defaults to the real
   * `config`-based check. A test sets this to force the tick to actually
   * run (with an injected `listEscrows` above) despite the test fixture
   * env's own empty Trustless Work variables. */
  reconcilerConfigComplete?: () => boolean;
  /** Overrides the platform address `runReconcilerOnce` cross-checks every
   * row against -- defaults to `config.trustlessWorkPlatformAddress`
   * (empty in the test fixture env). A test injecting a fake `listEscrows`
   * row needs this to actually match that row's own platform/disputeResolver/
   * admin roles. */
  reconcilerPlatformAddress?: string;
}

export interface RunnerHandle {
  stop: () => void;
}

/**
 * Starts both ticks. Each uses a re-arming `setTimeout` (not a bare
 * `setInterval`) so a slow tick can never overlap the next one -- the next
 * timer is only scheduled once the current run (success or isolated
 * failure) has finished.
 */
export function startRunner(db: Db, options: StartRunnerOptions = {}): RunnerHandle {
  const log = options.log ?? defaultLog;
  const reconcilerIntervalMs = options.reconcilerIntervalMs ?? RECONCILER_INTERVAL_MS;
  const holdExpiryIntervalMs = options.holdExpiryIntervalMs ?? HOLD_EXPIRY_INTERVAL_MS;
  const trustlessWorkConfigComplete = options.reconcilerConfigComplete ?? defaultTrustlessWorkConfigComplete;
  const listEscrows = options.listEscrows ?? realListEscrows();

  let stopped = false;
  let reconcilerTimer: NodeJS.Timeout | undefined;
  let holdExpiryTimer: NodeJS.Timeout | undefined;
  let warnedConfigIncomplete = false;

  function scheduleReconciler(): void {
    if (stopped) return;
    reconcilerTimer = setTimeout(async () => {
      await runTickIsolated(
        "reconciler",
        async () => {
          if (!trustlessWorkConfigComplete()) {
            if (!warnedConfigIncomplete) {
              log("[runner] reconciler tick skipped: Trustless Work config is incomplete (see .env.example)");
              warnedConfigIncomplete = true;
            }
            return;
          }
          warnedConfigIncomplete = false;
          const result = await runReconcilerOnce({
            db,
            listEscrows,
            log,
            ...(options.reconcilerPlatformAddress !== undefined ? { platformAddress: options.reconcilerPlatformAddress } : {}),
          });
          if (result.applied > 0 || result.anomalies > 0) {
            log(
              `[runner] reconciler tick: applied=${result.applied} duplicates=${result.duplicates} ` +
                `anomalies=${result.anomalies} skipped=${result.skipped}`,
            );
          }
        },
        log,
      );
      scheduleReconciler();
    }, reconcilerIntervalMs);
    reconcilerTimer.unref?.();
  }

  function scheduleHoldExpiry(): void {
    if (stopped) return;
    holdExpiryTimer = setTimeout(async () => {
      await runTickIsolated(
        "hold-expiry",
        async () => {
          expireHolds(db, Math.floor(Date.now() / 1000), log);
        },
        log,
      );
      scheduleHoldExpiry();
    }, holdExpiryIntervalMs);
    holdExpiryTimer.unref?.();
  }

  scheduleReconciler();
  scheduleHoldExpiry();

  return {
    stop: () => {
      stopped = true;
      if (reconcilerTimer) clearTimeout(reconcilerTimer);
      if (holdExpiryTimer) clearTimeout(holdExpiryTimer);
    },
  };
}
