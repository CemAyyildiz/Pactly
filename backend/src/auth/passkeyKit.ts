/**
 * Stellar Passkey Kit (jury ask): Face ID / fingerprint creates a Soroban
 * smart wallet (`C…`) in the browser. SEP-10, SEP-6 and Trustless Work still
 * need a classic `G…` account, so this module also derives a rail keypair
 * from the contract id, stores that seed, and issues the Pactly JWT with
 * the rail as `sub`. The browser still runs `createWallet` / `connectWallet`;
 * this backend (1) fee-sponsors the `C…` deploy and (2) signs classic
 * envelopes with the rail via `/me/sign`.
 *
 * Relayer: if `PASSKEY_RELAYER_BASE_URL` + `PASSKEY_RELAYER_API_KEY` are
 * set, submission goes through `PasskeyServer`. Otherwise a deterministic
 * testnet fee-payer (derived from `PACTLY_AUTH_SIGNING_SECRET`, friendbot-
 * funded) wraps the envelope. Neither secret belongs in the browser bundle.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc as StellarRpc,
} from "@stellar/stellar-sdk";
import { PasskeyServer } from "passkey-kit/server";

import { config } from "../config.js";
import { encryptSecret, passkeyKitRailKeypair } from "../custodial/keys.js";
import { ensureAccountReadyInBackground } from "../custodial/funding.js";
import type { Db } from "../db/client.js";
import { getUserByWalletAddress, insertUser, updateUserWalletAndSecret } from "../db/users.js";
import { issuePactlyJwt } from "./challenge.js";

/** Stored on `users.encrypted_secret` so `/me/sign` knows there is no seed. */
export const PASSKEY_KIT_SECRET_MARKER = "passkey-kit";

const FRIENDBOT_TIMEOUT_MS = 20_000;
const SUBMIT_POLL_MS = 2_000;
const SUBMIT_POLL_ATTEMPTS = 20;

export class PasskeyKitSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyKitSubmitError";
  }
}

export class PasskeyKitAccountError extends Error {
  constructor(message = "That is not a Passkey Kit smart wallet.") {
    super(message);
    this.name = "PasskeyKitAccountError";
  }
}

export function isPasskeyKitUserSecret(encryptedSecret: string): boolean {
  return encryptedSecret === PASSKEY_KIT_SECRET_MARKER;
}

/** Deterministic G… that pays fees on testnet. Not the user's wallet. */
export function passkeyKitFeePayer(): Keypair {
  const seed = createHash("sha256").update(`pactly-passkey-kit-fee-payer:${config.pactlyAuthSigningSecret}`).digest();
  return Keypair.fromRawEd25519Seed(seed);
}

/**
 * Classic G… that holds USDC and signs SEP-10 / Trustless Work for a
 * Passkey Kit `C…` identity. Smart wallets cannot friendbot, cannot open a
 * classic trustline, and cannot sign a SEP-10 challenge — the TRY deposit
 * and lock still need this rail. Derived from the contract id so reconnect
 * always lands on the same account.
 */
export { passkeyKitRailKeypair } from "../custodial/keys.js";

function rpcServer(): StellarRpc.Server {
  return new StellarRpc.Server(config.sorobanRpcUrl, { allowHttp: true });
}

async function ensureFeePayerFunded(payer: Keypair): Promise<void> {
  const server = rpcServer();
  try {
    await server.getAccount(payer.publicKey());
    return;
  } catch {
    // Not on ledger yet — friendbot, then retry the load.
  }
  const url = `${config.friendbotUrl}${config.friendbotUrl.includes("?") ? "&" : "?"}addr=${encodeURIComponent(payer.publicKey())}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(FRIENDBOT_TIMEOUT_MS) });
  if (!response.ok) {
    throw new PasskeyKitSubmitError(`Friendbot refused to fund the passkey fee-payer (HTTP ${response.status}).`);
  }
}

function relayerServer(): PasskeyServer | undefined {
  if (!config.passkeyRelayerBaseUrl || !config.passkeyRelayerApiKey) {
    return undefined;
  }
  return new PasskeyServer({
    networkPassphrase: config.stellarNetworkPassphrase,
    rpcUrl: config.sorobanRpcUrl,
    relayer: {
      baseUrl: config.passkeyRelayerBaseUrl,
      apiKey: config.passkeyRelayerApiKey,
    },
  });
}

async function pollUntilSuccess(hash: string): Promise<string> {
  const server = rpcServer();
  for (let attempt = 0; attempt < SUBMIT_POLL_ATTEMPTS; attempt += 1) {
    const result = await server.getTransaction(hash);
    if (result.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash;
    }
    if (result.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
      throw new PasskeyKitSubmitError("The passkey wallet transaction failed on chain.");
    }
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_POLL_MS));
  }
  throw new PasskeyKitSubmitError("The passkey wallet transaction is still pending.");
}

/** The auth entry's credentials arm name, read across the two XDR object
 * shapes stellar-sdk ships: 16's js-xdr accessors (`credentials()`,
 * `switch()`) and 17's plain-property objects with a `toXdrObject()`
 * bridge back to the accessor form. `undefined` when neither fits. */
function credentialsKindOf(entry: unknown): string | undefined {
  const raw = entry as { toXdrObject?: () => unknown } | undefined;
  const legacy = (typeof raw?.toXdrObject === "function" ? raw.toXdrObject() : raw) as
    | { credentials?: unknown }
    | undefined;
  const credentials = typeof legacy?.credentials === "function" ? (legacy.credentials as () => unknown)() : legacy?.credentials;
  const arm = credentials as { switch?: unknown } | undefined;
  const sw = typeof arm?.switch === "function" ? (arm.switch as () => unknown)() : arm?.switch;
  if (typeof sw === "string") return sw;
  const named = sw as { name?: unknown } | undefined;
  return typeof named?.name === "string" ? named.name : undefined;
}

/** Whether any invokeHostFunction op carries source-account auth -- such an
 * envelope can only be fee-bumped, never rebuilt around another source. */
function hasSourceAccountAuth(transaction: Transaction): boolean {
  for (const op of transaction.operations) {
    if (op.type !== "invokeHostFunction") continue;
    for (const entry of op.auth ?? []) {
      if (credentialsKindOf(entry) === "sorobanCredentialsSourceAccount") {
        return true;
      }
    }
  }
  return false;
}

/**
 * What a passkey-kit relayer does with a `{ func, auth }` submission: the
 * kit's "deployment carrier" names the shared, sign-only deployer as its
 * envelope source, so it can never be submitted (or fee-bumped) as is.
 * Rebuild the single host function -- with the passkey/deployer-signed
 * auth entries the carrier already holds -- into a fresh envelope sourced
 * and paid by this backend's testnet fee-payer, simulate it for resources,
 * sign, submit and wait. A multi-op or source-account-auth envelope keeps
 * the plain fee-bump path.
 */
async function feeBumpAndSend(unsignedOrSignedXdr: string): Promise<string> {
  const payer = passkeyKitFeePayer();
  await ensureFeePayerFunded(payer);
  const parsed = TransactionBuilder.fromXDR(unsignedOrSignedXdr, config.stellarNetworkPassphrase);
  const server = rpcServer();
  let toSend: Transaction | FeeBumpTransaction;

  const singleOp = parsed instanceof Transaction && parsed.operations.length === 1 ? parsed.operations[0] : undefined;
  if (parsed instanceof Transaction && singleOp?.type === "invokeHostFunction" && !hasSourceAccountAuth(parsed)) {
    const payerAccount = await server.getAccount(payer.publicKey());
    const rebuilt = new TransactionBuilder(payerAccount, {
      fee: BASE_FEE,
      networkPassphrase: config.stellarNetworkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func: singleOp.func, auth: singleOp.auth ?? [] }))
      .setTimeout(60)
      .build();
    let prepared: Transaction;
    try {
      // The carrier's auth entries are already signed; `prepareTransaction`
      // keeps them and only fills in the footprint and resource fee.
      prepared = (await server.prepareTransaction(rebuilt)) as Transaction;
    } catch (error) {
      throw new PasskeyKitSubmitError(
        `The passkey wallet transaction failed simulation${error instanceof Error && error.message ? `: ${error.message.slice(0, 300)}` : "."}`,
      );
    }
    prepared.sign(payer);
    toSend = prepared;
  } else if (parsed instanceof Transaction) {
    const bump = TransactionBuilder.buildFeeBumpTransaction(payer, "10000000", parsed, config.stellarNetworkPassphrase);
    bump.sign(payer);
    toSend = bump;
  } else {
    toSend = parsed;
  }

  const sent = await server.sendTransaction(toSend);
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    throw new PasskeyKitSubmitError(sent.errorResult ? "The network rejected the passkey transaction." : "The network could not take the passkey transaction.");
  }
  return pollUntilSuccess(sent.hash);
}

/**
 * Submits a Passkey Kit envelope (wallet deploy or a later signed invoke).
 * Prefers the OpenZeppelin relayer when configured; otherwise fee-bumps.
 */
export async function submitPasskeyKitXdr(xdr: string): Promise<{ hash: string }> {
  const relayer = relayerServer();
  if (relayer) {
    const result = await relayer.send(xdr);
    if (!result.success) {
      const message =
        "error" in result && result.error && typeof result.error === "object" && "message" in result.error
          ? String(result.error.message)
          : "The relayer rejected the passkey transaction.";
      throw new PasskeyKitSubmitError(message);
    }
    return { hash: result.hash };
  }
  try {
    const hash = await feeBumpAndSend(xdr);
    return { hash };
  } catch (error) {
    if (error instanceof PasskeyKitSubmitError) {
      throw error;
    }
    // RPC/SDK failures (bad XDR, network, simulation) are submission
    // failures too -- name them rather than surfacing a bare 500.
    const detail = error instanceof Error && error.message ? error.message.slice(0, 300) : String(error);
    throw new PasskeyKitSubmitError(`Could not submit the passkey wallet transaction: ${detail}`);
  }
}

export interface PasskeyKitSession {
  token: string;
  walletAddress: string;
  contractId: string;
}

/** Issues a Pactly JWT for the `G…` rail behind a Passkey Kit `C…` wallet,
 * creating (or migrating) the users row on first sight. The Face ID step
 * still deploys the smart wallet; deposits and lock use the rail key. */
export async function sessionForPasskeyKitWallet(
  db: Db,
  contractId: string,
): Promise<PasskeyKitSession> {
  if (!StrKey.isValidContract(contractId)) {
    throw new PasskeyKitAccountError();
  }
  const rail = passkeyKitRailKeypair(contractId);
  const railAddress = rail.publicKey();
  const encryptedSecret = encryptSecret(rail.secret());

  let user = await getUserByWalletAddress(db, railAddress);
  if (!user) {
    const legacy = await getUserByWalletAddress(db, contractId);
    if (legacy && isPasskeyKitUserSecret(legacy.encryptedSecret)) {
      await updateUserWalletAndSecret(db, legacy.id, {
        walletAddress: railAddress,
        encryptedSecret,
        funded: false,
        usdcTrustline: false,
      });
      user = await getUserByWalletAddress(db, railAddress);
    } else {
      const id = randomUUID();
      await insertUser(db, {
        id,
        displayName: "",
        walletAddress: railAddress,
        encryptedSecret,
        createdAt: Date.now(),
      });
      user = await getUserByWalletAddress(db, railAddress);
    }
  } else if (isPasskeyKitUserSecret(user.encryptedSecret)) {
    await updateUserWalletAndSecret(db, user.id, {
      walletAddress: railAddress,
      encryptedSecret,
      funded: false,
      usdcTrustline: false,
    });
    user = await getUserByWalletAddress(db, railAddress);
  }
  if (!user) {
    throw new PasskeyKitAccountError();
  }
  ensureAccountReadyInBackground(db, railAddress);
  return { token: await issuePactlyJwt(railAddress), walletAddress: railAddress, contractId };
}

