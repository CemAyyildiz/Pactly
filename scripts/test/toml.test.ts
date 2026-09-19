import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCurrencies, resolveUsdcAsset, TomlParseError } from "../src/toml.js";

// Real, checksum-valid Stellar account ids (generated with Keypair.random())
// — resolveUsdcAsset now rejects anything that isn't one.
const EURC_ISSUER = "GCKT7ISZCCQSEKKJ3WOXTIFLNFMWZOGICL2HAWLAPL4QFUNOOA4UH7PG";
const USDC_ISSUER = "GB23LBWL5BNFPBRFPR3KI4RT6EVUL77VKNCH4D5IEXF7PESQTEY4KC4S";

const TOML_WITH_USDC = `
VERSION="2.0.0"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

[[CURRENCIES]]
code = "EURC"
issuer = "${EURC_ISSUER}"
display_decimals = 7

[[CURRENCIES]]
code = "USDC"
issuer = "${USDC_ISSUER}"
display_decimals = 7
name = "USD Coin"
`;

test("parseCurrencies returns every [[CURRENCIES]] table in order", () => {
  const currencies = parseCurrencies(TOML_WITH_USDC);
  assert.equal(currencies.length, 2);
  assert.equal(currencies[0]?.code, "EURC");
  assert.equal(currencies[1]?.code, "USDC");
});

test("parseCurrencies returns an empty list when the body declares none", () => {
  assert.deepEqual(parseCurrencies('VERSION="2.0.0"'), []);
});

test("resolveUsdcAsset returns the matching issuer and code, ignoring other currencies", () => {
  const asset = resolveUsdcAsset(parseCurrencies(TOML_WITH_USDC), "USDC");
  assert.deepEqual(asset, { code: "USDC", issuer: USDC_ISSUER });
});

test("resolveUsdcAsset names the currencies it did find when there is no match", () => {
  const currencies = parseCurrencies(TOML_WITH_USDC);
  assert.throws(
    () => resolveUsdcAsset(currencies, "USDT"),
    (error: unknown) => error instanceof TomlParseError && /found: EURC, USDC/.test(error.message),
  );
});

test("resolveUsdcAsset reports no CURRENCIES entries at all", () => {
  assert.throws(
    () => resolveUsdcAsset([], "USDC"),
    (error: unknown) => error instanceof TomlParseError && /declares no CURRENCIES entries/.test(error.message),
  );
});

test("resolveUsdcAsset reports a missing issuer field by name", () => {
  const malformed = `
[[CURRENCIES]]
code = "USDC"
display_decimals = 7
`;
  assert.throws(
    () => resolveUsdcAsset(parseCurrencies(malformed), "USDC"),
    (error: unknown) => error instanceof TomlParseError && /missing "issuer"/.test(error.message),
  );
});

test("resolveUsdcAsset rejects an issuer that is not a valid Stellar account id", () => {
  const malformed = `
[[CURRENCIES]]
code = "USDC"
issuer = "not-an-account-id"
`;
  assert.throws(
    () => resolveUsdcAsset(parseCurrencies(malformed), "USDC"),
    (error: unknown) => error instanceof TomlParseError && /not a valid Stellar account id/.test(error.message),
  );
});

test("parseCurrencies wraps a non-TOML body's own parser error", () => {
  assert.throws(
    () => parseCurrencies("this is not { valid toml : at : all"),
    (error: unknown) => error instanceof TomlParseError && /not valid TOML/.test(error.message),
  );
});
