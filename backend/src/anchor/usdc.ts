/**
 * Resolves the anchor's USDC asset from its `stellar.toml` (AD-10) and
 * derives the Stellar Asset Contract (SAC) id every Story 3.4 booking hold
 * uses as `tokenAddress` -- resolved once and cached, per the spec's own
 * "Always" rule ("The USDC asset comes from the anchor's stellar.toml
 * (AD-10), resolved once and cached... No token address constant exists in
 * code").
 *
 * Mirrors `scripts/src/toml.ts`'s `resolveUsdcAsset` rather than importing
 * it: `backend` and `scripts` are separate npm workspaces, and
 * `anchor/stellar-toml.ts`'s own top comment already established this
 * "re-derive the same small parsing step" discipline for exactly this
 * reason.
 */
import { Asset, StrKey } from "@stellar/stellar-sdk";
import { parse, type TomlTable } from "smol-toml";

import { config } from "../config.js";
import { AnchorDiscoveryError } from "./errors.js";
import { fetchAnchorToml, type FetchLike } from "./stellar-toml.js";

interface AnchorCurrency {
  code?: string;
  issuer?: string;
  [key: string]: unknown;
}

function parseCurrencies(tomlBody: string, homeDomain: string): AnchorCurrency[] {
  let parsed: TomlTable;
  try {
    parsed = parse(tomlBody);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorDiscoveryError(`${homeDomain}'s stellar.toml is not valid TOML: ${reason}`);
  }
  const currencies = parsed.CURRENCIES;
  if (currencies === undefined) {
    return [];
  }
  if (!Array.isArray(currencies)) {
    throw new AnchorDiscoveryError(`${homeDomain}'s stellar.toml CURRENCIES key is not a list of tables`);
  }
  return currencies.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AnchorDiscoveryError(`${homeDomain}'s stellar.toml CURRENCIES[${index}] is not a table`);
    }
    return entry as AnchorCurrency;
  });
}

export interface UsdcAsset {
  code: string;
  issuer: string;
  /** The SAC contract id (`C...`) for this asset on
   * `config.stellarNetworkPassphrase` -- `Asset.contractId(...)`'s own
   * deterministic derivation, never a stored or hard-coded value. */
  contractId: string;
}

/** Pure text-in, value-out (mirrors `stellar-toml.ts`'s `parseSepEndpoints`
 * and `scripts/src/toml.ts`'s `resolveUsdcAsset`): finds the `USDC`
 * `[[CURRENCIES]]` entry, validates its `issuer` is a real Stellar account
 * id, and derives the SAC contract id for `networkPassphrase`. Throws
 * {@link AnchorDiscoveryError}, naming what is missing or invalid, before
 * ever touching the network again. */
export function resolveUsdcAssetFromToml(
  tomlBody: string,
  homeDomain: string,
  networkPassphrase: string,
  assetCode = "USDC",
): UsdcAsset {
  const currencies = parseCurrencies(tomlBody, homeDomain);
  const match = currencies.find((currency) => currency.code === assetCode);
  if (!match) {
    const found = currencies
      .map((currency) => currency.code)
      .filter((code): code is string => typeof code === "string" && code.length > 0);
    throw new AnchorDiscoveryError(
      found.length > 0
        ? `${homeDomain}'s stellar.toml has no ${assetCode} currency; found: ${found.join(", ")}`
        : `${homeDomain}'s stellar.toml declares no CURRENCIES entries`,
    );
  }
  if (typeof match.issuer !== "string" || match.issuer.trim() === "") {
    throw new AnchorDiscoveryError(`${homeDomain}'s stellar.toml's ${assetCode} currency entry is missing "issuer"`);
  }
  const issuer = match.issuer.trim();
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw new AnchorDiscoveryError(
      `${homeDomain}'s stellar.toml's ${assetCode} currency entry has an issuer that is not a valid Stellar account id: "${issuer}"`,
    );
  }
  if (typeof match.code !== "string" || match.code.trim() === "") {
    throw new AnchorDiscoveryError(`${homeDomain}'s stellar.toml's ${assetCode} currency entry is missing "code"`);
  }
  const code = match.code.trim();
  const contractId = new Asset(code, issuer).contractId(networkPassphrase);
  return { code, issuer, contractId };
}

let cachedUsdcAsset: UsdcAsset | undefined;

export interface ResolveUsdcAssetOptions {
  /** Overrides the anchor toml fetch -- defaults to the real network call. */
  fetchImpl?: FetchLike;
  /** Bypasses (and, on success, refreshes) the module-level cache -- a
   * test's own concern; the real caller never sets this. */
  forceRefresh?: boolean;
}

/**
 * Resolves the anchor's USDC asset and SAC contract id, fetching
 * `stellar.toml` only once per process (subsequent calls return the cached
 * value) -- the single place `services/booking.ts`'s `holdSlot` gets the
 * `tokenAddress` every booking hold carries.
 */
export async function resolveUsdcAsset(options: ResolveUsdcAssetOptions = {}): Promise<UsdcAsset> {
  if (cachedUsdcAsset && !options.forceRefresh) {
    return cachedUsdcAsset;
  }
  const tomlBody = await fetchAnchorToml(config.anchorHomeDomain, options.fetchImpl);
  const asset = resolveUsdcAssetFromToml(tomlBody, config.anchorHomeDomain, config.stellarNetworkPassphrase);
  cachedUsdcAsset = asset;
  return asset;
}

/** Test-only: clears the module-level cache so each test starts fresh. */
export function resetUsdcAssetCacheForTests(): void {
  cachedUsdcAsset = undefined;
}
