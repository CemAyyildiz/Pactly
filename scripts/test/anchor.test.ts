import assert from "node:assert/strict";
import { test } from "node:test";

import { AnchorUnreachableError, fetchAnchorToml, resolveAnchorUsdcAsset } from "../src/anchor.js";

test("fetchAnchorToml names the home domain and URL when the host cannot be reached", async () => {
  await assert.rejects(
    () =>
      fetchAnchorToml("unreachable.example", async () => {
        throw new Error("getaddrinfo ENOTFOUND unreachable.example");
      }),
    (error: unknown) =>
      error instanceof AnchorUnreachableError &&
      /Could not reach unreachable\.example/.test(error.message) &&
      error.message.includes("https://unreachable.example/.well-known/stellar.toml") &&
      /getaddrinfo ENOTFOUND/.test(error.message),
  );
});

test("fetchAnchorToml names the home domain and URL on a non-OK response", async () => {
  await assert.rejects(
    () =>
      fetchAnchorToml("no-toml.example", async () => ({
        ok: false,
        status: 404,
        text: async () => "",
      })),
    (error: unknown) =>
      error instanceof AnchorUnreachableError &&
      error.message.includes("no-toml.example") &&
      error.message.includes("https://no-toml.example/.well-known/stellar.toml") &&
      error.message.includes("404"),
  );
});

test("fetchAnchorToml returns the body on a reachable, OK response", async () => {
  const body = await fetchAnchorToml("anchor.example", async () => ({
    ok: true,
    status: 200,
    text: async () => "VERSION=\"2.0.0\"",
  }));
  assert.equal(body, 'VERSION="2.0.0"');
});

test("fetchAnchorToml's default implementation passes an abort signal, so a hanging host cannot block forever", async () => {
  const originalFetch = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return { ok: true, status: 200, text: async () => "" } as Response;
  }) as typeof fetch;
  try {
    await fetchAnchorToml("anchor.example");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test("resolveAnchorUsdcAsset resolves the USDC entry from a fetched two-currency body", async () => {
  const body = `
[[CURRENCIES]]
code = "EURC"
issuer = "GEURISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

[[CURRENCIES]]
code = "USDC"
issuer = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ"
`;
  const asset = await resolveAnchorUsdcAsset("anchor.example", async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  }));
  assert.deepEqual(asset, {
    code: "USDC",
    issuer: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
  });
});
