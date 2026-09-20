/**
 * Sign-in and signing for Pactly — Stellar Passkey Kit, not a wallet app.
 *
 * Jury ask: https://github.com/stellar/passkey-kit
 * A passkey (Face ID / fingerprint) is the on-chain signer of a Soroban
 * smart wallet (`C…`). There is no Freighter, no seed phrase, no custodial
 * `G…` secret. The module keeps `getSession` / `signIn` / `signOut` /
 * `signXdr` / `Session` so every screen that already calls those keeps
 * compiling.
 */
import { PasskeyKit, MercuryIndexer, SignerKey } from "passkey-kit";
import { IndexedDBStorage } from "passkey-kit/storage";
import { Transaction } from "@stellar/stellar-sdk";

import { ApiError, apiPost } from "../api/client";

const SESSION_STORAGE_KEY = "pactly.session";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = "https://soroban-testnet.stellar.org";
/** Canonical smart-wallet WASM (passkey-kit docs/deployments-2026-09-01.md). */
const WALLET_WASM_HASH = "97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e";

export interface Session {
  token: string;
  /**
   * Classic `G…` rail behind the Passkey Kit smart wallet. Face ID still
   * creates/connects a `C…` contract; deposits and lock need this account
   * (SEP-10 and Trustless Work are classic envelopes).
   */
  walletAddress: string;
}

export class SignInCancelledError extends Error {
  constructor() {
    super("The passkey prompt was closed before it finished.");
    this.name = "SignInCancelledError";
  }
}

let kitSingleton: PasskeyKit | undefined;
const storage = new IndexedDBStorage();

function passkeyRp(): { rpId: string; allowedOrigins: string[] } {
  if (typeof window === "undefined") {
    return { rpId: "localhost", allowedOrigins: ["http://localhost:5173"] };
  }
  const host = window.location.hostname;
  return {
    rpId: host === "127.0.0.1" ? "localhost" : host,
    allowedOrigins: [window.location.origin],
  };
}

function getKit(): PasskeyKit {
  if (!kitSingleton) {
    const rp = passkeyRp();
    kitSingleton = new PasskeyKit({
      rpcUrl: RPC_URL,
      networkPassphrase: NETWORK_PASSPHRASE,
      walletWasmHash: WALLET_WASM_HASH,
      rpId: rp.rpId,
      allowedOrigins: rp.allowedOrigins,
      requireUserVerification: true,
      storage,
    });
    normaliseSignerExpiration(kitSingleton);
  }
  return kitSingleton;
}

/**
 * passkey-kit 0.19.1 with @stellar/stellar-sdk 16.3.0: a signer created
 * without an expiration decodes its `Option<u64>` as `null`, but
 * `connectWallet` only skips the expiry check for `undefined` -- it then
 * compares `BigInt > null` (true) and crashes on `null.toString()`, so no
 * wallet can ever connect. Normalise the decoded value on the kit's own
 * signer reader until the kit handles `null` itself.
 */
function normaliseSignerExpiration(kit: PasskeyKit): void {
  const manager = (kit as unknown as { signerManager?: { getSigner: (key: unknown) => Promise<unknown> } }).signerManager;
  if (!manager || typeof manager.getSigner !== "function") {
    return;
  }
  const original = manager.getSigner.bind(manager);
  manager.getSigner = async (key: unknown) => {
    const value = (await original(key)) as { values?: unknown[] } | null;
    const inner = value?.values?.[1];
    if (Array.isArray(inner) && inner[0] === null) {
      inner[0] = undefined;
    }
    return value;
  };
}

export function getSession(): Session | undefined {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.token === "string" && typeof parsed.walletAddress === "string") {
      // Early kit sessions used the `C…` contract as `sub`. That cannot
      // SEP-10 or lock — drop it so the next passkey prompt mints the rail.
      if (parsed.walletAddress.startsWith("C")) {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        return undefined;
      }
      return { token: parsed.token, walletAddress: parsed.walletAddress };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Best-effort.
  }
}

export function signOut(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
  getKit().disconnect();
}

function isCancelled(error: unknown): boolean {
  if (error instanceof SignInCancelledError) {
    return true;
  }
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
}

interface KitSessionResponse {
  token: string;
  walletAddress: string;
}

interface KitSubmitResponse {
  hash: string;
}

async function issueSession(contractId: string): Promise<Session> {
  const verified = await apiPost<KitSessionResponse>("/auth/passkey-kit/session", { contractId });
  return { token: verified.token, walletAddress: verified.walletAddress };
}

async function connectExisting(): Promise<Session> {
  const kit = getKit();
  const indexer = MercuryIndexer.forNetwork({ rpc: kit.rpc }, NETWORK_PASSPHRASE);
  const connected = await kit.connectWallet({
    getWalletCandidates: indexer
      ? (keyId) => indexer.findWallets(SignerKey.Secp256r1(keyId))
      : undefined,
  });
  return issueSession(connected.contractId);
}

async function createAndDeploy(): Promise<Session> {
  const kit = getKit();
  const created = await kit.createWallet("Pactly", "pactly-user");
  const submitted = await apiPost<KitSubmitResponse>("/auth/passkey-kit/submit", { xdr: created.signedTx });
  await kit.confirmWalletCreation(created, submitted.hash);
  await kit.connectWallet({ keyId: created.keyIdBase64 });
  return issueSession(created.contractId);
}

/**
 * Passkey prompt. Returning users reconnect the smart wallet; a first-time
 * user deploys one. Same tap either way — IndexedDB is checked first so a
 * new visitor is not asked to "log in" to a wallet they do not have.
 */
export async function signIn(): Promise<Session> {
  let session: Session;
  const stored = await storage.getAll();
  try {
    if (stored.length > 0) {
      session = await connectExisting();
    } else {
      session = await createAndDeploy();
    }
  } catch (error) {
    if (isCancelled(error)) {
      throw new SignInCancelledError();
    }
    if (stored.length > 0) {
      try {
        session = await createAndDeploy();
      } catch (createError) {
        throw isCancelled(createError) ? new SignInCancelledError() : createError;
      }
    } else {
      throw error;
    }
  }
  saveSession(session);
  return session;
}

async function signInvokeAuth(unsignedXdr: string): Promise<string> {
  const kit = getKit();
  if (!kit.contractId) {
    const session = getSession();
    if (session?.walletAddress) {
      await kit.connectWallet({ keyId: undefined });
    }
  }
  const tx = new Transaction(unsignedXdr, NETWORK_PASSPHRASE);
  let signedAny = false;
  for (const op of tx.operations) {
    if (op.type !== "invokeHostFunction") {
      continue;
    }
    const auth = op.auth;
    if (!auth || auth.length === 0) {
      continue;
    }
    const signed = [];
    for (const entry of auth) {
      signed.push(await kit.signAuthEntry(entry as never));
    }
    op.auth = signed as unknown as typeof auth;
    signedAny = true;
  }
  if (!signedAny) {
    throw new ApiError(
      {
        code: "PASSKEY_KIT_SIGN",
        message: "This booking step is a classic Stellar signature. Your passkey signs the smart wallet instead — the lock still needs a Soroban auth entry from Trustless Work.",
      },
      400,
    );
  }
  return tx.toXDR();
}

/**
 * Sign a backend-built envelope. Passkey Kit sessions use a `G…` rail, so
 * lock and SEP-10 go through `POST /me/sign`. A leftover `C…` session still
 * signs Soroban auth in the browser.
 */
export async function signXdr(unsignedXdr: string, walletAddress: string): Promise<string> {
  const session = getSession();
  if (!session) {
    throw new ApiError({ code: "UNAUTHORIZED", message: "Your session ended. Sign in again to continue." }, 401);
  }
  if (walletAddress.startsWith("C")) {
    try {
      return await signInvokeAuth(unsignedXdr);
    } catch (error) {
      throw isCancelled(error) ? new SignInCancelledError() : error;
    }
  }
  const { signedXdr } = await apiPost<{ signedXdr: string }>("/me/sign", { unsignedXdr }, session.token);
  return signedXdr;
}
