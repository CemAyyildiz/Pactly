/**
 * `anchor/stellar-toml.ts` exercised as a unit: `fetch` is always injected,
 * so nothing here ever reaches `tr-mock-anchor.fly.dev`. Covers the I/O
 * matrix's "stellar.toml discovered" success row and "Anchor unreachable"
 * failure row, plus the parsing edge cases (missing field, invalid TOML)
 * that row's "nothing proceeds" guarantee depends on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  discoverAnchorSepEndpoints,
  fetchAnchorToml,
  parseSepEndpoints,
  type FetchLike,
} from "../src/anchor/stellar-toml.js";
import { AnchorDiscoveryError } from "../src/anchor/errors.js";

const REALISTIC_TOML = `
VERSION="2.0.0"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
WEB_AUTH_ENDPOINT="https://tr-mock-anchor.fly.dev/auth"
TRANSFER_SERVER="https://tr-mock-anchor.fly.dev/sep6"
KYC_SERVER="https://tr-mock-anchor.fly.dev/sep12"
ANCHOR_QUOTE_SERVER="https://tr-mock-anchor.fly.dev/sep38"
SIGNING_KEY="GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY"

[[CURRENCIES]]
code="USDC"
issuer="GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
`;

test("fetchAnchorToml returns the body on a reachable, OK response", async () => {
  const body = await fetchAnchorToml("anchor.example", async () => ({
    ok: true,
    status: 200,
    text: async () => REALISTIC_TOML,
  }));
  assert.equal(body, REALISTIC_TOML);
});

test("fetchAnchorToml names the domain and URL when the host cannot be reached", async () => {
  await assert.rejects(
    () =>
      fetchAnchorToml("unreachable.example", async () => {
        throw new Error("getaddrinfo ENOTFOUND unreachable.example");
      }),
    (error: unknown) =>
      error instanceof AnchorDiscoveryError &&
      error.message.includes("unreachable.example") &&
      error.message.includes("https://unreachable.example/.well-known/stellar.toml") &&
      /getaddrinfo ENOTFOUND/.test(error.message),
  );
});

test("fetchAnchorToml names the domain on a non-OK response, and nothing proceeds to parsing", async () => {
  await assert.rejects(
    () =>
      fetchAnchorToml("no-toml.example", async () => ({
        ok: false,
        status: 404,
        text: async () => "",
      })),
    (error: unknown) => error instanceof AnchorDiscoveryError && error.message.includes("no-toml.example") && error.message.includes("404"),
  );
});

test("parseSepEndpoints reads every SEP endpoint from a realistic stellar.toml, with none hard-coded", () => {
  const endpoints = parseSepEndpoints(REALISTIC_TOML, "tr-mock-anchor.fly.dev");
  assert.equal(endpoints.webAuthEndpoint, "https://tr-mock-anchor.fly.dev/auth");
  assert.equal(endpoints.signingKey, "GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY");
  assert.equal(endpoints.transferServer, "https://tr-mock-anchor.fly.dev/sep6");
  assert.equal(endpoints.kycServer, "https://tr-mock-anchor.fly.dev/sep12");
  assert.equal(endpoints.quoteServer, "https://tr-mock-anchor.fly.dev/sep38");
});

test("parseSepEndpoints throws, naming the domain, when WEB_AUTH_ENDPOINT is missing", () => {
  assert.throws(
    () => parseSepEndpoints('SIGNING_KEY="GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY"', "anchor.example"),
    (error: unknown) =>
      error instanceof AnchorDiscoveryError && error.message.includes("anchor.example") && error.message.includes("WEB_AUTH_ENDPOINT"),
  );
});

test("parseSepEndpoints throws, naming the domain, when SIGNING_KEY is missing", () => {
  assert.throws(
    () => parseSepEndpoints('WEB_AUTH_ENDPOINT="https://anchor.example/auth"', "anchor.example"),
    (error: unknown) => error instanceof AnchorDiscoveryError && error.message.includes("SIGNING_KEY"),
  );
});

test("parseSepEndpoints leaves optional fields undefined when the toml omits them", () => {
  const endpoints = parseSepEndpoints(
    'WEB_AUTH_ENDPOINT="https://anchor.example/auth"\nSIGNING_KEY="GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY"',
    "anchor.example",
  );
  assert.equal(endpoints.transferServer, undefined);
  assert.equal(endpoints.kycServer, undefined);
  assert.equal(endpoints.quoteServer, undefined);
});

test("parseSepEndpoints throws for a body that is not valid TOML", () => {
  assert.throws(() => parseSepEndpoints("this is not = toml [[[", "anchor.example"), AnchorDiscoveryError);
});

test("discoverAnchorSepEndpoints composes the fetch and the parse in one call", async () => {
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => REALISTIC_TOML });
  const endpoints = await discoverAnchorSepEndpoints("tr-mock-anchor.fly.dev", fetchImpl);
  assert.equal(endpoints.webAuthEndpoint, "https://tr-mock-anchor.fly.dev/auth");
});

test("discoverAnchorSepEndpoints never proceeds to parsing when the fetch fails", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    throw new Error("network down");
  };
  await assert.rejects(() => discoverAnchorSepEndpoints("anchor.example", fetchImpl), AnchorDiscoveryError);
  assert.equal(fetchCalls, 1);
});
