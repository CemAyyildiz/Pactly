/**
 * Parses the CURRENCIES section of a `stellar.toml` body and resolves the
 * anchor's USDC asset from it (AD-10). Pure text-in, value-out: no network call
 * lives here, only the decision of what the fetched body means. The issuer and
 * asset code are never hard-coded anywhere in this module — they only ever come
 * out of `resolveUsdcAsset`'s return value.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { parse, type TomlTable } from "smol-toml";

export class TomlParseError extends Error {}

export interface AnchorCurrency {
  code?: string;
  issuer?: string;
  [key: string]: unknown;
}

export interface UsdcAsset {
  code: string;
  issuer: string;
}

/** Every `[[CURRENCIES]]` table declared in a stellar.toml body, in file order. */
export function parseCurrencies(tomlBody: string): AnchorCurrency[] {
  let parsed: TomlTable;
  try {
    parsed = parse(tomlBody);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new TomlParseError(`stellar.toml is not valid TOML: ${reason}`);
  }
  const currencies = parsed.CURRENCIES;
  if (currencies === undefined) {
    return [];
  }
  if (!Array.isArray(currencies)) {
    throw new TomlParseError("stellar.toml's CURRENCIES key is not a list of tables");
  }
  return currencies.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TomlParseError(`stellar.toml CURRENCIES[${index}] is not a table`);
    }
    return entry as AnchorCurrency;
  });
}

/**
 * Finds the entry matching `assetCode` (default `"USDC"`) and returns its
 * issuer. Currencies with other codes are ignored. Throws naming what it did
 * find, or which field was missing, so the caller's error message names what to
 * do next per the spec's matrix.
 */
export function resolveUsdcAsset(currencies: AnchorCurrency[], assetCode = "USDC"): UsdcAsset {
  const match = currencies.find((currency) => currency.code === assetCode);
  if (!match) {
    const found = currencies
      .map((currency) => currency.code)
      .filter((code): code is string => typeof code === "string" && code.length > 0);
    throw new TomlParseError(
      found.length > 0
        ? `stellar.toml has no ${assetCode} currency; found: ${found.join(", ")}`
        : "stellar.toml declares no CURRENCIES entries",
    );
  }
  if (typeof match.issuer !== "string" || match.issuer.trim() === "") {
    throw new TomlParseError(`stellar.toml's ${assetCode} currency entry is missing "issuer"`);
  }
  const issuer = match.issuer.trim();
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw new TomlParseError(
      `stellar.toml's ${assetCode} currency entry has an issuer that is not a valid Stellar account id: "${issuer}"`,
    );
  }
  if (typeof match.code !== "string" || match.code.trim() === "") {
    throw new TomlParseError(`stellar.toml's ${assetCode} currency entry is missing "code"`);
  }
  return { code: match.code.trim(), issuer };
}
