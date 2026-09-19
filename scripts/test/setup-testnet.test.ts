import assert from "node:assert/strict";
import { test } from "node:test";

import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { Horizon } from "@stellar/stellar-sdk";

import { assertCompleteEnvLines, REQUIRED_ENV_LINE_KEYS, runSetupTestnet } from "../src/setup-testnet.js";

test("REQUIRED_ENV_LINE_KEYS names the keys the spec requires, among others", () => {
  assert.ok(REQUIRED_ENV_LINE_KEYS.includes("ESCROW_CONTRACT_ID"));
  assert.ok(REQUIRED_ENV_LINE_KEYS.includes("PACTLY_ADMIN_WALLETS"));
});

test("assertCompleteEnvLines does not throw when every required key is present", () => {
  const complete = Object.fromEntries(REQUIRED_ENV_LINE_KEYS.map((key) => [key, "value"]));
  assert.doesNotThrow(() => assertCompleteEnvLines(complete));
});

test("assertCompleteEnvLines throws when PACTLY_ADMIN_WALLETS is missing", () => {
  // This is exactly the shape a deleted `envLines.PACTLY_ADMIN_WALLETS = ...`
  // assignment would leave behind: every other key resolved, this one absent.
  const missingAdminWallets = Object.fromEntries(
    REQUIRED_ENV_LINE_KEYS.filter((key) => key !== "PACTLY_ADMIN_WALLETS").map((key) => [key, "value"]),
  );
  assert.throws(() => assertCompleteEnvLines(missingAdminWallets), /PACTLY_ADMIN_WALLETS/);
});

test("assertCompleteEnvLines names every missing key, not just the first", () => {
  assert.throws(
    () => assertCompleteEnvLines({}),
    (error: unknown) => error instanceof Error && REQUIRED_ENV_LINE_KEYS.every((key) => error.message.includes(key)),
  );
});

test("assertCompleteEnvLines checks a custom key list, not just the default", () => {
  assert.doesNotThrow(() => assertCompleteEnvLines({ ONLY_KEY: "value" }, ["ONLY_KEY"]));
  assert.throws(() => assertCompleteEnvLines({}, ["ONLY_KEY"]), /ONLY_KEY/);
});

// --- runSetupTestnet, end to end, against fully faked network/CLI seams ---
//
// Every external touchpoint (`stellar.toml`, Horizon, friendbot, the Stellar
// CLI) is faked via `SetupTestnetDeps`, and the fixture below sets things up
// so every step is already done (funded, trustlined, deployed) — no fake
// needs to simulate a state transition, only "yes, already there". This
// exercises the exact call site that resolves `PACTLY_ADMIN_WALLETS`, so
// deleting that assignment from `setup-testnet.ts` fails the test below,
// not just a unit test of `assertCompleteEnvLines` in isolation.

const ENV_KEYS_UNDER_TEST = [
  "ANCHOR_HOME_DOMAIN",
  "STELLAR_NETWORK_PASSPHRASE",
  "SOROBAN_RPC_URL",
  "PACTLY_DEMO_ADMIN_SECRET",
  "PACTLY_DEMO_PROFESSIONAL_SECRET",
  "PACTLY_DEMO_CLIENT_SECRET",
  "PACTLY_ADMIN_WALLETS",
  "ESCROW_CONTRACT_ID",
] as const;

// `run` is async, so the restoration in `finally` must `await` it — without
// that, `finally` fires as soon as `run()` returns its pending promise (i.e.
// right after its first internal `await`), undoing the fake env while
// `runSetupTestnet` is still mid-flight and still reading `process.env`.
async function withFakeEnv<T>(
  values: Partial<Record<(typeof ENV_KEYS_UNDER_TEST)[number], string>>,
  run: () => Promise<T>,
): Promise<T> {
  const originals = new Map(ENV_KEYS_UNDER_TEST.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS_UNDER_TEST) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await run();
  } finally {
    for (const [key, original] of originals) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

function fakeFundedAccount(withUsdcTrustline: boolean, issuer: string): Horizon.AccountResponse {
  const balances = withUsdcTrustline
    ? [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "0" }]
    : [];
  // Only `.balances` is read by the code path this test exercises — a full
  // Horizon.AccountResponse needs a live network response to construct.
  return { balances } as unknown as Horizon.AccountResponse;
}

test("runSetupTestnet prints PACTLY_ADMIN_WALLETS (and every required key) on a fully-faked, already-done run", async () => {
  const usdcIssuer = Keypair.random().publicKey();
  const contractId = `C${"D".repeat(55)}`;

  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  try {
    await withFakeEnv(
      {
        ANCHOR_HOME_DOMAIN: "anchor.example",
        STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        PACTLY_DEMO_ADMIN_SECRET: Keypair.random().secret(),
        PACTLY_DEMO_PROFESSIONAL_SECRET: Keypair.random().secret(),
        PACTLY_DEMO_CLIENT_SECRET: Keypair.random().secret(),
        ESCROW_CONTRACT_ID: contractId,
      },
      () =>
        runSetupTestnet({
          loadEnvFile: () => {}, // never touch the real repository .env
          fetchAnchorToml: async () => ({
            ok: true,
            status: 200,
            text: async () => `[[CURRENCIES]]\ncode = "USDC"\nissuer = "${usdcIssuer}"\n`,
          }),
          loadAccount: async () => fakeFundedAccount(true, usdcIssuer),
          friendbotCall: async () => undefined,
          submitTransaction: async () => undefined,
          cliProbe: () => {},
        }),
    );
  } finally {
    console.log = originalLog;
  }

  const printed = logged.join("\n");
  for (const key of REQUIRED_ENV_LINE_KEYS) {
    assert.match(printed, new RegExp(`(^|\\n)${key}=`), `expected ${key} in the printed .env lines`);
  }
});
