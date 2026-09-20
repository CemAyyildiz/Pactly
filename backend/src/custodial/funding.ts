/**
 * Gets a freshly created custodial account ready to hold USDC: fund it via
 * friendbot (testnet), then open the anchor's USDC trustline with a
 * change-trust this backend builds, signs with the custodial key and
 * submits itself -- the same `buildChangeTrustTransaction` /
 * `submitBalancePaymentTransaction` pair Story 2.4 already uses for a
 * wallet user, just signed here instead of in a browser wallet.
 *
 * Best-effort and idempotent: each step is skipped once its flag on the
 * `users` row is set, a failure leaves the flag unset (so the next call
 * simply retries that step), and concurrent calls for the same wallet
 * collapse onto one in-flight run. Called fire-and-forget right after
 * registration and lazily from `GET /me/account` -- never on the login
 * path, and never in a way that can block a response.
 *
 * Every network seam is injectable (`fetchImpl` for friendbot and the
 * anchor's `stellar.toml`; `buildTrustline`/`submitTrustline` for the
 * Soroban RPC account load and submit/poll), same discipline as
 * `services/localDeposit.ts`: a test that overrides them never leaves the
 * process.
 */
import { resolveUsdcAsset } from "../anchor/usdc.js";
import type { Sep38FetchLike } from "../anchor/sep38.js";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { getUserByWalletAddress, setUserAccountFlags, type UserRow } from "../db/users.js";
import {
  buildChangeTrustTransaction,
  submitBalancePaymentTransaction,
  type BuildPaymentDeps,
  type SubmitPaymentDeps,
} from "../payments/stellar.js";
import { AccountFundingError, NoCustodialAccountError } from "./errors.js";
import { signXdrForWallet } from "./keys.js";

const REQUEST_TIMEOUT_MS = 20_000;

export interface EnsureAccountReadyDeps {
  /** Friendbot *and* the anchor `stellar.toml` fetch (routed by URL) --
   * defaults to the real network. */
  fetchImpl?: Sep38FetchLike;
  /** How the change-trust's source account is loaded. */
  buildTrustline?: BuildPaymentDeps;
  /** How the signed change-trust is sent and polled. */
  submitTrustline?: SubmitPaymentDeps;
  /** Overrides the friendbot base URL (defaults to `config.friendbotUrl`). */
  friendbotUrl?: string;
}

export interface AccountReadiness {
  funded: boolean;
  usdcTrustline: boolean;
}

function defaultFetch(url: string, init?: { method?: string; headers?: Record<string, string> }) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** Friendbot reports "already funded" as a failed `create_account`
 * (`op_already_exists`) -- for this module that means the same as success:
 * the account exists. Anything else is a real refusal. */
async function alreadyExists(response: Pick<Response, "text">): Promise<boolean> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return false;
  }
  return /already/i.test(text);
}

async function fundViaFriendbot(walletAddress: string, deps: EnsureAccountReadyDeps): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const base = deps.friendbotUrl ?? config.friendbotUrl;
  const url = `${base}${base.includes("?") ? "&" : "?"}addr=${encodeURIComponent(walletAddress)}`;
  let response: Pick<Response, "ok" | "status" | "text">;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new AccountFundingError(`Could not reach friendbot: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (response.ok) return;
  if (response.status === 400 && (await alreadyExists(response))) return;
  throw new AccountFundingError(`Friendbot refused to fund ${walletAddress} (HTTP ${response.status}).`);
}

async function openUsdcTrustline(db: Db, walletAddress: string, deps: EnsureAccountReadyDeps): Promise<void> {
  const usdc = await resolveUsdcAsset({ fetchImpl: deps.fetchImpl });
  const built = await buildChangeTrustTransaction(
    { sourceAddress: walletAddress, assetCode: usdc.code, assetIssuer: usdc.issuer },
    deps.buildTrustline ?? {},
  );
  const signedXdr = await signXdrForWallet(db, walletAddress, built.unsignedXdr);
  await submitBalancePaymentTransaction(signedXdr, deps.submitTrustline ?? {});
}

const inFlight = new Map<string, Promise<AccountReadiness>>();

async function runEnsure(db: Db, user: UserRow, deps: EnsureAccountReadyDeps): Promise<AccountReadiness> {
  let funded = user.funded;
  let usdcTrustline = user.usdcTrustline;
  if (!funded) {
    await fundViaFriendbot(user.walletAddress, deps);
    funded = true;
    await setUserAccountFlags(db, user.id, { funded: true });
  }
  if (!usdcTrustline) {
    await openUsdcTrustline(db, user.walletAddress, deps);
    usdcTrustline = true;
    await setUserAccountFlags(db, user.id, { usdcTrustline: true });
  }
  return { funded, usdcTrustline };
}

/**
 * Funds (if not yet funded) and opens the USDC trustline (if not yet
 * open) for the custodial account owning `walletAddress`, persisting each
 * flag the moment its step lands. Throws {@link NoCustodialAccountError}
 * for an unknown wallet; rethrows the step's own typed failure
 * ({@link AccountFundingError}, `PaymentFailedError`,
 * `PaymentUnavailableError`, an anchor discovery error) with whatever
 * progress was made already saved.
 */
export async function ensureAccountReady(
  db: Db,
  walletAddress: string,
  deps: EnsureAccountReadyDeps = {},
): Promise<AccountReadiness> {
  const user = await getUserByWalletAddress(db, walletAddress);
  if (!user) {
    throw new NoCustodialAccountError();
  }
  if (user.encryptedSecret === "passkey-kit") {
    return { funded: true, usdcTrustline: true };
  }
  if (user.funded && user.usdcTrustline) {
    return { funded: true, usdcTrustline: true };
  }
  const existing = inFlight.get(walletAddress);
  if (existing) {
    return existing;
  }
  const run = runEnsure(db, user, deps).finally(() => {
    inFlight.delete(walletAddress);
  });
  inFlight.set(walletAddress, run);
  return run;
}

/** Fire-and-forget wrapper: the failure is logged (never thrown) so a
 * registration or `GET /me/account` response is never held up or failed by
 * a slow friendbot. */
export function ensureAccountReadyInBackground(db: Db, walletAddress: string, deps: EnsureAccountReadyDeps = {}): void {
  void ensureAccountReady(db, walletAddress, deps).catch((error: unknown) => {
    console.warn(
      `[custodial] account readiness for ${walletAddress} deferred: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
