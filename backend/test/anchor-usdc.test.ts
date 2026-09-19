/**
 * `anchor/usdc.ts` exercised as a unit: `resolveUsdcAssetFromToml` is pure
 * (no network), and `resolveUsdcAsset`'s own `fetch` is always injected, so
 * nothing here ever reaches `tr-mock-anchor.fly.dev`. Covers Story 3.4's
 * "Always" rule -- the USDC asset and its SAC contract id come only from
 * the anchor's `stellar.toml`, resolved once and cached -- and the missing/
 * invalid-issuer edge cases `resolveUsdcAssetFromToml` must refuse before
 * ever deriving a contract id.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Asset } from "@stellar/stellar-sdk";

import { resetUsdcAssetCacheForTests, resolveUsdcAsset, resolveUsdcAssetFromToml } from "../src/anchor/usdc.js";
import { AnchorDiscoveryError } from "../src/anchor/errors.js";

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const REALISTIC_TOML = `
VERSION="2.0.0"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE}"
WEB_AUTH_ENDPOINT="https://tr-mock-anchor.fly.dev/auth"
SIGNING_KEY="GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"

[[CURRENCIES]]
code="TRY"
issuer="GBOTHERISSUER00000000000000000000000000000000000000000"
`;

test("resolveUsdcAssetFromToml finds the USDC entry and derives its SAC contract id", () => {
  const asset = resolveUsdcAssetFromToml(REALISTIC_TOML, "anchor.example", NETWORK_PASSPHRASE);
  assert.equal(asset.code, "USDC");
  assert.equal(asset.issuer, USDC_ISSUER);
  assert.equal(asset.contractId, new Asset("USDC", USDC_ISSUER).contractId(NETWORK_PASSPHRASE));
});

test("resolveUsdcAssetFromToml throws naming the other codes found when USDC is absent", () => {
  const tomlWithoutUsdc = `
[[CURRENCIES]]
code="TRY"
issuer="${USDC_ISSUER}"
`;
  assert.throws(
    () => resolveUsdcAssetFromToml(tomlWithoutUsdc, "anchor.example", NETWORK_PASSPHRASE),
    (error: unknown) => error instanceof AnchorDiscoveryError && /TRY/.test(error.message),
  );
});

test("resolveUsdcAssetFromToml throws for an issuer that is not a valid Stellar account id", () => {
  const badToml = `
[[CURRENCIES]]
code="USDC"
issuer="not-a-real-account-id"
`;
  assert.throws(
    () => resolveUsdcAssetFromToml(badToml, "anchor.example", NETWORK_PASSPHRASE),
    AnchorDiscoveryError,
  );
});

test("resolveUsdcAssetFromToml throws for no CURRENCIES entries at all", () => {
  assert.throws(() => resolveUsdcAssetFromToml("VERSION=\"2.0.0\"", "anchor.example", NETWORK_PASSPHRASE), AnchorDiscoveryError);
});

test("resolveUsdcAsset fetches once and caches -- a second call does not fetch again", async () => {
  resetUsdcAssetCacheForTests();
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return { ok: true, status: 200, text: async () => REALISTIC_TOML };
  };

  const first = await resolveUsdcAsset({ fetchImpl });
  const second = await resolveUsdcAsset({ fetchImpl });
  assert.equal(fetchCount, 1, "the anchor's stellar.toml must be fetched only once");
  assert.deepEqual(second, first);
  resetUsdcAssetCacheForTests();
});
