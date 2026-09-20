/**
 * Story 2.4: the local-currency (SEP-6) deposit path for a held booking.
 * The client signs the anchor challenge in their wallet; this module never
 * holds a key. Statuses are mapped to plain words here; SEP vocabulary
 * never leaves the route layer's JSON.
 */
import { Horizon } from "@stellar/stellar-sdk";

import { config } from "../config.js";
import {
  AmountOutOfRangeError,
  AnchorQuoteUnavailableError,
} from "../anchor/errors.js";
import { type AnchorFetchLike } from "../anchor/http.js";
import {
  fetchSep6DepositLimits,
  fetchSep6Transaction,
  isSandboxAnchor,
  openSep6Deposit,
  simulateSep6BankTransfer,
  type BankDetails,
  type Sep6Transaction,
} from "../anchor/sep6-deposit.js";
import { ensureSep12Approved } from "../anchor/sep12.js";
import { fetchIndicativePrice } from "../anchor/sep38.js";
import { resolveUsdcAsset } from "../anchor/usdc.js";
import {
  extendHoldExpiresAt,
  setAnchorDeposit,
  setAnchorTrustlineTxHash,
  type BookingRow,
} from "../db/bookings.js";
import type { Db } from "../db/client.js";
import {
  buildChangeTrustTransaction,
  smallestUnitToStellarAmount,
  submitBalancePaymentTransaction,
  type BuildPaymentDeps,
  type SubmitPaymentDeps,
} from "../payments/stellar.js";
import {
  beginAnchorSep10,
  completeAnchorSep10,
  requireFreshAnchorJwt,
  type GetOrRefreshAnchorJwtDeps,
} from "./auth.js";
import {
  BookingEscrowStateError,
  BookingHoldExpiredError,
  HOLD_DURATION_SECONDS,
  XdrMismatchError,
  getBookingForClient,
} from "./booking.js";

export { BookingEscrowStateError, BookingHoldExpiredError, BookingNotFoundError, XdrMismatchError } from "./booking.js";

export class SandboxOnlyError extends Error {
  constructor(message = "Simulate is only available on the sandbox anchor.") {
    super(message);
    this.name = "SandboxOnlyError";
  }
}

function requireHoldNotExpired(booking: BookingRow, now: number): void {
  if (booking.escrowState === null && booking.holdExpiresAt !== null && booking.holdExpiresAt <= now) {
    throw new BookingHoldExpiredError();
  }
}

export type LocalDepositUiStatus = "waiting" | "paying" | "received" | "failed" | "needs_trustline";

const STATUS_WORDS: Record<LocalDepositUiStatus, string> = {
  waiting: "Waiting for your transfer",
  paying: "Paying into your wallet",
  received: "Money received",
  failed: "The transfer did not go through",
  needs_trustline: "Getting your wallet ready",
};

function mapSep6Status(status: string): LocalDepositUiStatus {
  switch (status) {
    case "completed":
      return "received";
    case "pending_anchor":
    case "pending_stellar":
      return "paying";
    case "error":
    case "expired":
    case "no_market":
    case "too_small":
    case "too_large":
      return "failed";
    case "pending_trust":
      return "needs_trustline";
    default:
      return "waiting";
  }
}

function parseExpiresAt(isoOrUndefined: string | undefined, nowMs: number): number | undefined {
  if (!isoOrUndefined) return undefined;
  const ms = Date.parse(isoOrUndefined);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(nowMs / 1000) + HOLD_DURATION_SECONDS;
}

function fiatToMinor(decimal: string): bigint | undefined {
  if (!/^\d+(\.\d+)?$/.test(decimal.trim())) return undefined;
  const [whole = "0", fraction = ""] = decimal.trim().split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

/** SEP-6 deposit amount on this rail is TRY at 2 decimal places. */
function toTwoDecimalPlaces(decimal: string): string {
  const minor = fiatToMinor(decimal);
  if (minor === undefined) {
    throw new AnchorQuoteUnavailableError(`Could not format the local-currency amount "${decimal}"`);
  }
  const whole = minor / 100n;
  const fraction = (minor % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

function defaultHorizonUrl(): string {
  return config.stellarNetworkPassphrase.startsWith("Public Global Stellar Network")
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

export interface LocalDepositDeps extends GetOrRefreshAnchorJwtDeps {
  fetchImpl?: AnchorFetchLike;
  now?: () => number;
  hasTrustline?: (account: string, assetCode: string, assetIssuer: string) => Promise<boolean>;
  buildTrustline?: BuildPaymentDeps;
  submitTrustline?: SubmitPaymentDeps;
}

function authDeps(deps: LocalDepositDeps): GetOrRefreshAnchorJwtDeps {
  return {
    now: deps.now,
    tomlFetch: deps.tomlFetch ?? deps.fetchImpl,
    sep10Fetch: deps.sep10Fetch ?? deps.fetchImpl,
  };
}

async function defaultHasTrustline(account: string, assetCode: string, assetIssuer: string): Promise<boolean> {
  try {
    const horizon = new Horizon.Server(defaultHorizonUrl());
    const loaded = await horizon.loadAccount(account);
    return loaded.balances.some(
      (balance) =>
        "asset_code" in balance && balance.asset_code === assetCode && balance.asset_issuer === assetIssuer,
    );
  } catch {
    return false;
  }
}

function snapshotBankDetails(details: BankDetails): string {
  return JSON.stringify(details);
}

function parseBankDetails(json: string | null): BankDetails {
  if (!json) return {};
  try {
    return JSON.parse(json) as BankDetails;
  } catch {
    return {};
  }
}

export interface LocalDepositView {
  status: LocalDepositUiStatus;
  statusLabel: string;
  bankDetails: BankDetails;
  moreInfoUrl?: string;
  expiresAt?: number;
  holdExpiresAt: number | null;
  sandbox: boolean;
  stale?: boolean;
  reason?: string;
}

function toView(booking: BookingRow, extras: { stale?: boolean; reason?: string } = {}): LocalDepositView {
  const raw = booking.anchorDepositStatus ?? "pending_user_transfer_start";
  const status = mapSep6Status(raw);
  return {
    status,
    statusLabel: STATUS_WORDS[status],
    bankDetails: parseBankDetails(booking.anchorDepositBankDetails),
    moreInfoUrl: booking.anchorDepositMoreInfoUrl ?? undefined,
    expiresAt: booking.anchorDepositExpiresAt ?? undefined,
    holdExpiresAt: booking.holdExpiresAt,
    sandbox: isSandboxAnchor(),
    stale: extras.stale,
    reason: extras.reason ?? (status === "failed" ? "The transfer did not go through. You can try again or pay with your wallet." : undefined),
  };
}

async function loadOwnedHold(db: Db, bookingId: string, walletAddress: string, nowSeconds: number): Promise<BookingRow> {
  const booking = await getBookingForClient(db, bookingId, walletAddress);
  requireHoldNotExpired(booking, nowSeconds);
  return booking;
}

export async function beginBookingAnchorAuth(
  db: Db,
  bookingId: string,
  walletAddress: string,
  deps: LocalDepositDeps = {},
) {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  return beginAnchorSep10(db, walletAddress, authDeps(deps));
}

export async function completeBookingAnchorAuth(
  db: Db,
  bookingId: string,
  walletAddress: string,
  signedXdr: string,
  deps: LocalDepositDeps = {},
): Promise<void> {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  await completeAnchorSep10(db, walletAddress, signedXdr, authDeps(deps));
}

export type OpenLocalDepositResult =
  | { needsTrustline: true; unsignedXdr: string }
  | ({ needsTrustline?: false } & LocalDepositView);

async function enforceLimits(depositAmount: string, fetchImpl: AnchorFetchLike | undefined): Promise<void> {
  const limits = await fetchSep6DepositLimits({ fetchImpl });
  if (!limits.minAmount && !limits.maxAmount) {
    return;
  }
  let fiatAmount: string;
  let currency: string;
  try {
    const quote = await fetchIndicativePrice({ amount: depositAmount }, { fetchImpl });
    fiatAmount = quote.fiat.amount;
    currency = quote.fiat.currency;
  } catch (error) {
    if (error instanceof AnchorQuoteUnavailableError) {
      return;
    }
    throw error;
  }
  const amountMinor = fiatToMinor(fiatAmount);
  const minMinor = limits.minAmount ? fiatToMinor(limits.minAmount) : undefined;
  const maxMinor = limits.maxAmount ? fiatToMinor(limits.maxAmount) : undefined;
  if (amountMinor === undefined) return;
  if ((minMinor !== undefined && amountMinor < minMinor) || (maxMinor !== undefined && amountMinor > maxMinor)) {
    throw new AmountOutOfRangeError(limits.minAmount ?? "0", limits.maxAmount ?? "—", currency);
  }
}

async function persistOpened(
  db: Db,
  bookingId: string,
  opened: { id: string; bankDetails: BankDetails; moreInfoUrl?: string; expiresAt?: string; amountIn?: string },
  nowMs: number,
  extraStatus?: string,
): Promise<void> {
  await setAnchorDeposit(db, bookingId, {
    id: opened.id,
    status: extraStatus ?? "pending_user_transfer_start",
    moreInfoUrl: opened.moreInfoUrl,
    bankDetailsJson: snapshotBankDetails(opened.bankDetails),
    expiresAt: parseExpiresAt(opened.expiresAt, nowMs) ?? null,
    amountIn: opened.amountIn ?? null,
    updatedAt: Math.floor(nowMs / 1000),
  });
}

async function openAgainstAnchor(
  db: Db,
  booking: BookingRow,
  walletAddress: string,
  deps: LocalDepositDeps,
): Promise<LocalDepositView> {
  const nowMs = deps.now?.() ?? Date.now();
  const token = await requireFreshAnchorJwt(db, walletAddress, authDeps(deps));
  await ensureSep12Approved({ token, account: walletAddress }, { fetchImpl: deps.fetchImpl });
  const quote = await fetchIndicativePrice({ amount: booking.depositAmount }, { fetchImpl: deps.fetchImpl });
  const tryAmount = toTwoDecimalPlaces(quote.fiat.amount);
  const opened = await openSep6Deposit(
    { token, account: walletAddress, amount: tryAmount, memo: booking.id.slice(0, 28) },
    { fetchImpl: deps.fetchImpl },
  );
  await persistOpened(db, booking.id, opened, nowMs);
  await extendHoldExpiresAt(db, booking.id, Math.floor(nowMs / 1000) + HOLD_DURATION_SECONDS);
  const fresh = await getBookingForClient(db, booking.id, walletAddress);
  return toView(fresh);
}

export async function openLocalDeposit(
  db: Db,
  bookingId: string,
  walletAddress: string,
  deps: LocalDepositDeps = {},
): Promise<OpenLocalDepositResult> {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const booking = await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError("This booking's deposit is already locked.");
  }

  if (booking.anchorDepositId && booking.anchorDepositStatus && mapSep6Status(booking.anchorDepositStatus) !== "failed") {
    return toView(booking);
  }

  await requireFreshAnchorJwt(db, walletAddress, authDeps(deps));
  await enforceLimits(booking.depositAmount, deps.fetchImpl);

  const usdc = await resolveUsdcAsset({ fetchImpl: deps.fetchImpl });
  const hasTrustline = deps.hasTrustline ?? defaultHasTrustline;
  const ready = await hasTrustline(walletAddress, usdc.code, usdc.issuer);
  if (!ready) {
    const built = await buildChangeTrustTransaction(
      { sourceAddress: walletAddress, assetCode: usdc.code, assetIssuer: usdc.issuer },
      deps.buildTrustline ?? {},
    );
    await setAnchorTrustlineTxHash(db, bookingId, built.txHash);
    return { needsTrustline: true, unsignedXdr: built.unsignedXdr };
  }

  return openAgainstAnchor(db, booking, walletAddress, deps);
}

export async function submitLocalDepositTrustline(
  db: Db,
  bookingId: string,
  walletAddress: string,
  signedXdr: string,
  deps: LocalDepositDeps = {},
): Promise<OpenLocalDepositResult> {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const booking = await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  if (!booking.anchorTrustlineTxHash) {
    throw new XdrMismatchError();
  }
  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  let hash: string;
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, config.stellarNetworkPassphrase);
    hash = Buffer.from(tx.hash()).toString("hex").toLowerCase();
  } catch {
    throw new XdrMismatchError();
  }
  if (hash !== booking.anchorTrustlineTxHash) {
    throw new XdrMismatchError();
  }
  await submitBalancePaymentTransaction(signedXdr, deps.submitTrustline ?? {});
  return openAgainstAnchor(db, booking, walletAddress, deps);
}

export async function pollLocalDeposit(
  db: Db,
  bookingId: string,
  walletAddress: string,
  deps: LocalDepositDeps = {},
): Promise<LocalDepositView> {
  const nowMs = deps.now?.() ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const booking = await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  if (!booking.anchorDepositId) {
    throw new BookingEscrowStateError("No local-currency transfer is in progress for this booking.");
  }
  try {
    const token = await requireFreshAnchorJwt(db, walletAddress, authDeps(deps));
    const tx: Sep6Transaction = await fetchSep6Transaction(booking.anchorDepositId, token, { fetchImpl: deps.fetchImpl });
    const ui = mapSep6Status(tx.status);
    await setAnchorDeposit(db, bookingId, {
      id: tx.id,
      status: tx.status,
      moreInfoUrl: tx.moreInfoUrl ?? booking.anchorDepositMoreInfoUrl,
      bankDetailsJson: booking.anchorDepositBankDetails ?? snapshotBankDetails(tx.bankDetails),
      expiresAt: parseExpiresAt(tx.expiresAt, nowMs) ?? booking.anchorDepositExpiresAt,
      amountIn: tx.amountIn ?? booking.anchorDepositAmountIn,
      updatedAt: nowSeconds,
    });
    if (ui === "waiting" || ui === "paying" || ui === "needs_trustline") {
      await extendHoldExpiresAt(db, bookingId, nowSeconds + HOLD_DURATION_SECONDS);
    }
    const fresh = await getBookingForClient(db, bookingId, walletAddress);
    return toView(fresh, { reason: tx.message });
  } catch (error) {
    if (error instanceof BookingHoldExpiredError) throw error;
    return toView(booking, { stale: true });
  }
}

export async function simulateLocalDeposit(
  db: Db,
  bookingId: string,
  walletAddress: string,
  deps: LocalDepositDeps = {},
): Promise<LocalDepositView> {
  if (!isSandboxAnchor()) {
    throw new SandboxOnlyError();
  }
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const booking = await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  if (!booking.anchorDepositId) {
    throw new BookingEscrowStateError("No local-currency transfer is in progress for this booking.");
  }
  const rawAmount = booking.anchorDepositAmountIn ?? smallestUnitToStellarAmount(booking.depositAmount);
  const amount = toTwoDecimalPlaces(rawAmount);
  await simulateSep6BankTransfer(booking.anchorDepositId, amount, { fetchImpl: deps.fetchImpl });
  return pollLocalDeposit(db, bookingId, walletAddress, deps);
}
