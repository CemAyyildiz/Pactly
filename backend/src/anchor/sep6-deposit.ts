/**
 * Story 2.4: the anchor's SEP-6 deposit client -- info (limits), open,
 * poll, and the sandbox-only simulate-bank-transfer. Everything about the
 * anchor comes from `stellar.toml` (AD-10). Status strings stay as the
 * anchor sent them; mapping to plain words is the service layer's job.
 */
import { config } from "../config.js";
import { AnchorDepositError, AnchorUnavailableError } from "./errors.js";
import {
  anchorReasonFromResponse,
  defaultAnchorFetch,
  tryReadJson,
  type AnchorFetchLike,
} from "./http.js";
import { discoverAnchorSepEndpoints } from "./stellar-toml.js";
import { resolveUsdcAsset } from "./usdc.js";

export type AnchorFetch = AnchorFetchLike;

export interface Sep6Limits {
  /** Advertised min in the on-chain asset's decimal units, if any. */
  minAmount?: string;
  /** Advertised max in the on-chain asset's decimal units, if any. */
  maxAmount?: string;
  assetCode: string;
}

export interface BankDetails {
  iban?: string;
  organization?: string;
  reference?: string;
  how?: string;
  extraMessage?: string;
}

export interface OpenSep6DepositParams {
  token: string;
  account: string;
  /** Decimal string in local currency (TRY, 2 decimal places). */
  amount: string;
  /** Booking id, sent as the anchor's memo/reference when it accepts one. */
  memo: string;
}

export interface OpenSep6DepositResult {
  id: string;
  bankDetails: BankDetails;
  moreInfoUrl?: string;
  expiresAt?: string;
  amountIn?: string;
}

export interface Sep6Transaction {
  id: string;
  status: string;
  message?: string;
  moreInfoUrl?: string;
  expiresAt?: string;
  amountIn?: string;
  bankDetails: BankDetails;
}

export interface Sep6Options {
  fetchImpl?: AnchorFetchLike;
}

async function resolveTransferServer(fetchImpl: AnchorFetchLike): Promise<{ transferServer: string; assetCode: string }> {
  let endpoints;
  let usdc;
  try {
    [endpoints, usdc] = await Promise.all([
      discoverAnchorSepEndpoints(config.anchorHomeDomain, fetchImpl),
      resolveUsdcAsset({ fetchImpl }),
    ]);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not resolve ${config.anchorHomeDomain}'s SEP-6 support: ${reason}`);
  }
  if (!endpoints.transferServer) {
    throw new AnchorUnavailableError(`${config.anchorHomeDomain}'s stellar.toml does not declare TRANSFER_SERVER`);
  }
  return { transferServer: endpoints.transferServer.replace(/\/$/, ""), assetCode: usdc.code };
}

function instructionValue(instructions: unknown, key: string): string | undefined {
  if (typeof instructions !== "object" || instructions === null) return undefined;
  const entry = (instructions as Record<string, unknown>)[key];
  if (typeof entry === "string" && entry.trim() !== "") return entry.trim();
  if (typeof entry === "object" && entry !== null) {
    const value = (entry as { value?: unknown }).value;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function parseBankDetails(body: unknown): BankDetails {
  const root = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const how = typeof root.how === "string" ? root.how.trim() : undefined;
  const extra =
    typeof root.extra_info === "object" && root.extra_info !== null
      ? (root.extra_info as { message?: unknown }).message
      : undefined;
  const extraMessage = typeof extra === "string" && extra.trim() !== "" ? extra.trim() : undefined;
  const instructions = root.instructions;
  return {
    iban:
      instructionValue(instructions, "iban") ??
      instructionValue(instructions, "IBAN") ??
      instructionValue(instructions, "bank_account_number"),
    organization:
      instructionValue(instructions, "organization") ??
      instructionValue(instructions, "bank_name"),
    reference:
      instructionValue(instructions, "reference") ??
      instructionValue(instructions, "external_transfer_memo") ??
      instructionValue(instructions, "memo") ??
      (typeof root.memo === "string" ? root.memo.trim() : undefined),
    how: how || undefined,
    extraMessage,
  };
}

function parseTransactionEnvelope(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const tx = (body as { transaction?: unknown }).transaction;
  if (typeof tx === "object" && tx !== null) return tx as Record<string, unknown>;
  return body as Record<string, unknown>;
}

function parseSep6Transaction(body: unknown): Sep6Transaction {
  const tx = parseTransactionEnvelope(body);
  const id = typeof tx.id === "string" ? tx.id.trim() : "";
  const status = typeof tx.status === "string" ? tx.status.trim() : "";
  if (!id || !status) {
    throw new AnchorDepositError(`${config.anchorHomeDomain}'s SEP-6 transaction response was missing id or status`);
  }
  const message = typeof tx.message === "string" && tx.message.trim() !== "" ? tx.message.trim() : undefined;
  const moreInfoUrl =
    typeof tx.more_info_url === "string" && tx.more_info_url.trim() !== "" ? tx.more_info_url.trim() : undefined;
  const expiresAt = typeof tx.expires_at === "string" && tx.expires_at.trim() !== "" ? tx.expires_at.trim() : undefined;
  const amountIn = typeof tx.amount_in === "string" && tx.amount_in.trim() !== "" ? tx.amount_in.trim() : undefined;
  return { id, status, message, moreInfoUrl, expiresAt, amountIn, bankDetails: parseBankDetails({ ...tx, instructions: tx.instructions }) };
}

/** Reads advertised min/max from `/sep6/info` for the anchor's USDC
 * deposit. Missing limits mean the sandbox advertises none -- the service
 * then skips the range check rather than inventing 50–3000 TRY. */
export async function fetchSep6DepositLimits(options: Sep6Options = {}): Promise<Sep6Limits> {
  const fetchImpl = options.fetchImpl ?? defaultAnchorFetch;
  const { transferServer, assetCode } = await resolveTransferServer(fetchImpl);
  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(`${transferServer}/info`, { method: "GET" });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not reach ${config.anchorHomeDomain}'s SEP-6 info endpoint: ${reason}`);
  }
  if (!response.ok) {
    const reason = await anchorReasonFromResponse(response);
    throw new AnchorUnavailableError(
      `${config.anchorHomeDomain} refused SEP-6 info (HTTP ${response.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  const body = await tryReadJson(response);
  const deposit =
    typeof body === "object" && body !== null ? (body as { deposit?: Record<string, Record<string, unknown>> }).deposit : undefined;
  const assetInfo = deposit?.[assetCode];
  const minAmount = typeof assetInfo?.min_amount === "string" ? assetInfo.min_amount.trim() : undefined;
  const maxAmount = typeof assetInfo?.max_amount === "string" ? assetInfo.max_amount.trim() : undefined;
  return { minAmount: minAmount || undefined, maxAmount: maxAmount || undefined, assetCode };
}

export async function openSep6Deposit(
  params: OpenSep6DepositParams,
  options: Sep6Options = {},
): Promise<OpenSep6DepositResult> {
  const fetchImpl = options.fetchImpl ?? defaultAnchorFetch;
  const { transferServer, assetCode } = await resolveTransferServer(fetchImpl);
  const url = new URL(`${transferServer}/deposit`);
  url.searchParams.set("asset_code", assetCode);
  url.searchParams.set("account", params.account);
  // This sandbox (and SEP-6 deposit generally) takes the *off-chain* amount
  // -- TRY at 2 decimal places -- not the USDC 7dp string. Sending
  // "90.0000000" is refused with "amount supports at most 2 decimal places".
  url.searchParams.set("amount", params.amount);
  url.searchParams.set("funding_method", "bank_account");
  if (params.memo.length > 0 && params.memo.length <= 28) {
    url.searchParams.set("memo", params.memo);
    url.searchParams.set("memo_type", "text");
  }

  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${params.token}` },
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not reach ${config.anchorHomeDomain}'s SEP-6 deposit endpoint: ${reason}`);
  }
  if (!response.ok) {
    const reason = await anchorReasonFromResponse(response);
    throw new AnchorDepositError(
      `${config.anchorHomeDomain} refused the deposit (HTTP ${response.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  const body = await tryReadJson(response);
  const root = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const id = typeof root.id === "string" ? root.id.trim() : "";
  if (!id) {
    throw new AnchorDepositError(`${config.anchorHomeDomain}'s SEP-6 deposit response did not include an id`);
  }
  const moreInfoUrl =
    typeof root.more_info_url === "string" && root.more_info_url.trim() !== ""
      ? root.more_info_url.trim()
      : `${transferServer}/tx/${encodeURIComponent(id)}`;
  // `eta` on this sandbox is "seconds until USDC lands *after* the bank
  // transfer" (5), not how long the client has to pay -- never treat it as
  // an expiry.
  const expiresAt =
    typeof root.expires_at === "string" && root.expires_at.trim() !== "" ? root.expires_at.trim() : undefined;
  const amountIn =
    typeof root.amount_in === "string" && root.amount_in.trim() !== "" ? root.amount_in.trim() : params.amount;
  return { id, bankDetails: parseBankDetails(body), moreInfoUrl, expiresAt, amountIn };
}

export async function fetchSep6Transaction(
  id: string,
  token: string,
  options: Sep6Options = {},
): Promise<Sep6Transaction> {
  const fetchImpl = options.fetchImpl ?? defaultAnchorFetch;
  const { transferServer } = await resolveTransferServer(fetchImpl);
  const url = new URL(`${transferServer}/transaction`);
  url.searchParams.set("id", id);
  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not reach ${config.anchorHomeDomain}'s SEP-6 transaction endpoint: ${reason}`);
  }
  if (!response.ok) {
    const reason = await anchorReasonFromResponse(response);
    throw new AnchorUnavailableError(
      `${config.anchorHomeDomain} refused SEP-6 transaction (HTTP ${response.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  return parseSep6Transaction(await tryReadJson(response));
}

export async function simulateSep6BankTransfer(
  id: string,
  amount: string,
  options: Sep6Options = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? defaultAnchorFetch;
  const { transferServer } = await resolveTransferServer(fetchImpl);
  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(`${transferServer}/tx/${encodeURIComponent(id)}/simulate-bank-transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount }),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not reach ${config.anchorHomeDomain}'s simulate endpoint: ${reason}`);
  }
  if (!response.ok) {
    const reason = await anchorReasonFromResponse(response);
    // The sandbox returns 409 when the transfer was already applied
    // (double-click, or the operator used the more-info URL). Treat that
    // as success so the following poll can surface "Money received".
    if (response.status === 409) {
      return;
    }
    throw new AnchorDepositError(
      `${config.anchorHomeDomain} refused the simulated transfer (HTTP ${response.status})${reason ? `: ${reason}` : ""}`,
      { simulate: true },
    );
  }
}

/** The hackathon sandbox home domain -- simulate is only offered here.
 * Everything else is discovered from stellar.toml; this is the one
 * sandbox-vs-real fork the spec itself names. */
export function isSandboxAnchor(homeDomain: string = config.anchorHomeDomain): boolean {
  return homeDomain === "tr-mock-anchor.fly.dev";
}
