import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
// Points at a file that does not exist, so a developer's real root .env is never loaded.
const noEnvFile = join(mkdtempSync(join(tmpdir(), "pactly-config-")), "absent.env");

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

function baseEnv(port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PACTLY_ENV_FILE: noEnvFile,
    BACKEND_PORT: String(port),
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    ANCHOR_HOME_DOMAIN: "tr-mock-anchor.fly.dev",
    PACTLY_HOME_DOMAIN: "pactly.test",
    PACTLY_AUTH_SIGNING_SECRET: "test-signing-secret-not-for-production-use",
    ESCROW_CONTRACT_ID: "",
    PACTLY_ADMIN_WALLETS: "",
    DATABASE_PATH: "./data/pactly.db",
  };
}

function startBackend(env: NodeJS.ProcessEnv) {
  return spawn(process.execPath, ["--import", "tsx", entry], { env, stdio: ["ignore", "pipe", "pipe"] });
}

test("exits 1 and names the variable when a required one is unset", async () => {
  const env = baseEnv(await freePort());
  delete env.SOROBAN_RPC_URL;
  const child = startBackend(env);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((done) => child.on("exit", done));
  assert.equal(code, 1);
  assert.match(stderr, /SOROBAN_RPC_URL/);
});

test("exits 1 and names the variable when PACTLY_AUTH_SIGNING_SECRET is unset", async () => {
  const env = baseEnv(await freePort());
  delete env.PACTLY_AUTH_SIGNING_SECRET;
  const child = startBackend(env);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((done) => child.on("exit", done));
  assert.equal(code, 1);
  assert.match(stderr, /PACTLY_AUTH_SIGNING_SECRET/);
});

test("exits 1 and names the length requirement when PACTLY_AUTH_SIGNING_SECRET is too short", async () => {
  const env = baseEnv(await freePort());
  env.PACTLY_AUTH_SIGNING_SECRET = "short-secret"; // 12 chars, under the 32-char floor
  const child = startBackend(env);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((done) => child.on("exit", done));
  assert.equal(code, 1);
  assert.match(stderr, /PACTLY_AUTH_SIGNING_SECRET/);
  assert.match(stderr, /32/);
});

test("starts and serves /health when declared-but-empty variables are empty", async () => {
  const port = await freePort();
  const child = startBackend(baseEnv(port));
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  let timer: NodeJS.Timeout | undefined;
  try {
    const listening = new Promise<void>((done) => {
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("listening")) done();
      });
    });
    const outcome = await Promise.race([
      listening.then(() => "listening" as const),
      exited.then(() => "exited" as const),
      new Promise<"timeout">((done) => {
        timer = setTimeout(() => done("timeout"), 15_000);
      }),
    ]);
    assert.equal(outcome, "listening", `backend did not start; stderr: ${stderr}`);
    const response = await fetch(`http://localhost:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    clearTimeout(timer);
    child.kill();
    await exited;
  }
});
