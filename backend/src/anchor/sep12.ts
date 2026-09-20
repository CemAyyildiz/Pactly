/**
 * Story 2.4: the anchor's SEP-12 customer endpoint. The hackathon mock
 * auto-approves a wallet without personal data, so this never invents KYC
 * fields -- it puts the account, reads the status, and treats anything
 * other than ACCEPTED as a typed failure. A real anchor that later asks
 * for fields surfaces that as {@link AnchorKycError} rather than this
 * backend guessing values.
 */
import { config } from "../config.js";
import { AnchorKycError, AnchorUnavailableError } from "./errors.js";
import {
  anchorReasonFromResponse,
  defaultAnchorFetch,
  tryReadJson,
  type AnchorFetchLike,
} from "./http.js";
import { discoverAnchorSepEndpoints } from "./stellar-toml.js";

const ACCEPTED = "ACCEPTED";

export interface EnsureSep12ApprovedParams {
  token: string;
  account: string;
}

export interface EnsureSep12ApprovedOptions {
  fetchImpl?: AnchorFetchLike;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function readCustomerStatus(
  kycServer: string,
  account: string,
  token: string,
  fetchImpl: AnchorFetchLike,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${kycServer.replace(/\/$/, "")}/customer`);
  url.searchParams.set("account", account);
  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(url.toString(), { method: "GET", headers: bearer(token) });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not reach ${config.anchorHomeDomain}'s SEP-12 endpoint: ${reason}`);
  }
  return { status: response.status, body: await tryReadJson(response) };
}

function statusOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const status = (body as { status?: unknown }).status;
  return typeof status === "string" ? status.toUpperCase() : undefined;
}

/**
 * Ensures the wallet is ACCEPTED with the anchor. The mock auto-approves
 * on PUT with only `{ account }`; if a later anchor returns NEEDS_INFO
 * with required fields, this refuses rather than inventing values.
 */
export async function ensureSep12Approved(
  params: EnsureSep12ApprovedParams,
  options: EnsureSep12ApprovedOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? defaultAnchorFetch;
  let endpoints;
  try {
    endpoints = await discoverAnchorSepEndpoints(config.anchorHomeDomain, fetchImpl);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not resolve ${config.anchorHomeDomain}'s SEP-12 support: ${reason}`);
  }
  if (!endpoints.kycServer) {
    throw new AnchorUnavailableError(`${config.anchorHomeDomain}'s stellar.toml does not declare KYC_SERVER`);
  }
  const kycServer = endpoints.kycServer.replace(/\/$/, "");

  const existing = await readCustomerStatus(kycServer, params.account, params.token, fetchImpl);
  if (existing.status < 300 && statusOf(existing.body) === ACCEPTED) {
    return;
  }

  let putResponse: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    putResponse = await fetchImpl(`${kycServer}/customer`, {
      method: "PUT",
      headers: { ...bearer(params.token), "content-type": "application/json" },
      body: JSON.stringify({ account: params.account }),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not reach ${config.anchorHomeDomain}'s SEP-12 endpoint: ${reason}`);
  }
  if (!putResponse.ok) {
    const reason = await anchorReasonFromResponse(putResponse);
    throw new AnchorKycError(
      `${config.anchorHomeDomain} refused SEP-12 (HTTP ${putResponse.status})${reason ? `: ${reason}` : ""}`,
    );
  }

  const after = await readCustomerStatus(kycServer, params.account, params.token, fetchImpl);
  const status = statusOf(after.body);
  if (after.status < 300 && status === ACCEPTED) {
    return;
  }
  if (status === "NEEDS_INFO") {
    throw new AnchorKycError(
      `${config.anchorHomeDomain} needs extra identity information this flow does not collect. Pay with a wallet holding USDC instead.`,
    );
  }
  throw new AnchorKycError(
    `${config.anchorHomeDomain} did not approve this wallet for a local-currency transfer${status ? ` (status ${status})` : ""}.`,
  );
}
