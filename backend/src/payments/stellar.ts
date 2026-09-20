/**
 * Story 3.7: the plain Stellar USDC "pay the balance" payment -- a classic
 * `Operation.payment` from the booking's own client wallet to the
 * provider's wallet, entirely independent of the escrow contract and the
 * Trustless Work adapter (AD-3: this never touches `escrow_state` or
 * `escrow/`). This is not a Soroban contract invocation, so it does not go
 * through `../escrow/` or the old `../chain/` client -- it is its own small
 * module, per the spec's own Code Map.
 *
 * Same "every network access is an injectable, overridable function"
 * discipline `chain/client.ts` and `escrow/trustless-work/client.ts`
 * already follow (mirrored, not shared, since this story's own Boundaries
 * say "No change to escrow, the reconciler or chain/"): a caller that does
 * not override a stage gets the real Soroban RPC endpoint
 * (`config.sorobanRpcUrl`); a test that overrides every stage never touches
 * the network at all.
 *
 * This module never signs anything -- like `escrow/trustless-work/client.ts`,
 * it only ever builds unsigned XDR (`buildBalancePaymentTransaction`) or
 * relays an envelope the caller's own wallet already signed
 * (`submitBalancePaymentTransaction`).
 */
import { Account, Asset, BASE_FEE, Operation, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { PaymentFailedError, PaymentUnavailableError } from "./errors.js";

/** USDC's own decimal precision on Stellar (matches `frontend/src/lib/
 * money.ts`'s `SMALLEST_UNIT_DECIMALS` and `services/profile.ts`'s
 * `computeDepositAmount`). */
const SMALLEST_UNIT_DECIMALS = 7;

/** The unsigned payment's own timeout -- 5 minutes, per the spec's own
 * "Always" rule ("a `TransactionBuilder` with a base fee and a 5-minute
 * timeout"). */
const PAYMENT_TIMEOUT_SECONDS = 5 * 60;

/** Stellar's own ceiling for any classic-asset amount: `i64::MAX` stroops
 * (2^63 - 1). `Operation.payment` would otherwise let the SDK itself throw
 * an untyped error deep inside its own amount parsing -- refusing here,
 * before that call, keeps the failure typed and diagnosable the same way
 * every other amount validation in this codebase already is. */
const MAX_INT64_STROOPS = 9223372036854775807n;

/**
 * Converts an AD-7 integer smallest-unit string into the decimal string
 * Stellar's classic `Operation.payment` amount expects -- exact string
 * arithmetic (never a float, never a `Number` round trip), matching the I/O
 * matrix's own worked example: `"14000000000"` -> `"1400.0000000"`. Throws
 * a plain {@link TypeError} for anything that is not a non-negative integer
 * string (the matrix's own "Non-integer string: refused" row), or that
 * exceeds {@link MAX_INT64_STROOPS}.
 */
export function smallestUnitToStellarAmount(amount: string): string {
  if (!/^\d+$/.test(amount)) {
    throw new TypeError(`amount must be a non-negative integer string, got "${amount}"`);
  }
  const value = BigInt(amount);
  if (value > MAX_INT64_STROOPS) {
    throw new TypeError(`amount exceeds Stellar's own int64 stroop maximum (${MAX_INT64_STROOPS}), got "${amount}"`);
  }
  const divisor = 10n ** BigInt(SMALLEST_UNIT_DECIMALS);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(SMALLEST_UNIT_DECIMALS, "0");
  return `${whole}.${fraction}`;
}

export interface BuildBalancePaymentInput {
  /** The booking's own client wallet (G...) -- the payment's source. */
  sourceAddress: string;
  /** The booking's own provider wallet (G...) -- the payment's
   * destination. */
  destinationAddress: string;
  /** The anchor-resolved USDC asset's own code and issuer (3.4's
   * `anchor/usdc.ts` resolver) -- a classic Stellar `Asset`, never the SAC
   * contract id `escrow_contract_id`/`token_address` use (this is a plain
   * classic payment, not a Soroban call). */
  assetCode: string;
  assetIssuer: string;
  /** Integer string, smallest unit (AD-7); must be a positive integer. */
  amount: string;
}

export interface BuildBalancePaymentResult {
  unsignedXdr: string;
  txHash: string;
}

export interface BuildPaymentDeps {
  /** Overrides how the source account (and its sequence number) is loaded
   * -- defaults to the real Soroban RPC call. */
  getAccount?: (publicKey: string) => Promise<Account>;
}

function defaultGetAccount(publicKey: string): Promise<Account> {
  return new rpc.Server(config.sorobanRpcUrl).getAccount(publicKey);
}

/**
 * Builds the unsigned "pay the balance" transaction: one classic
 * `Operation.payment`, a base fee, and a 5-minute timeout (the spec's own
 * "Always" rule). Never signs it -- the caller's own wallet does that,
 * exactly like every `EscrowAdapter` mutate method's own unsigned-XDR
 * contract.
 */
export async function buildBalancePaymentTransaction(
  input: BuildBalancePaymentInput,
  deps: BuildPaymentDeps = {},
): Promise<BuildBalancePaymentResult> {
  const getAccount = deps.getAccount ?? defaultGetAccount;
  const amount = smallestUnitToStellarAmount(input.amount);
  const sourceAccount = await getAccount(input.sourceAddress);
  const asset = new Asset(input.assetCode, input.assetIssuer);
  const tx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: config.stellarNetworkPassphrase })
    .addOperation(Operation.payment({ destination: input.destinationAddress, asset, amount }))
    .setTimeout(PAYMENT_TIMEOUT_SECONDS)
    .build();
  // `Transaction.hash()` returns a `Uint8Array`, not a Node `Buffer` -- wrap
  // it to get `.toString("hex")` (mirrors `services/booking.ts`'s own
  // `computeSignedTransactionHash`).
  return { unsignedXdr: tx.toXDR(), txHash: Buffer.from(tx.hash()).toString("hex").toLowerCase() };
}

export interface BuildChangeTrustInput {
  sourceAddress: string;
  assetCode: string;
  assetIssuer: string;
}

/**
 * Story 2.4: unsigned change-trust so a wallet without the anchor's USDC
 * can receive the deposit. Same builder/timeout/unsigned-XDR discipline as
 * {@link buildBalancePaymentTransaction}; the term "trustline" never
 * leaves this module.
 */
export async function buildChangeTrustTransaction(
  input: BuildChangeTrustInput,
  deps: BuildPaymentDeps = {},
): Promise<BuildBalancePaymentResult> {
  const getAccount = deps.getAccount ?? defaultGetAccount;
  const sourceAccount = await getAccount(input.sourceAddress);
  const asset = new Asset(input.assetCode, input.assetIssuer);
  const tx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: config.stellarNetworkPassphrase })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(PAYMENT_TIMEOUT_SECONDS)
    .build();
  return { unsignedXdr: tx.toXDR(), txHash: Buffer.from(tx.hash()).toString("hex").toLowerCase() };
}

export interface SubmitPaymentDeps {
  sendTransaction?: (tx: Transaction) => Promise<rpc.Api.SendTransactionResponse>;
  waitForTransaction?: (hash: string) => Promise<rpc.Api.GetTransactionResponse>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Review follow-up: the built transaction itself carries a 5-minute
 * timeout (`PAYMENT_TIMEOUT_SECONDS` above), but the old defaults here
 * (10 attempts, 1.5s apart) gave up after ~13.5s -- long before Soroban
 * would ever consider the envelope itself expired. Raised so the default
 * poll window covers the transaction's own full timeout instead of quitting
 * on it early. */
export const DEFAULT_POLL_ATTEMPTS = 200;
export const DEFAULT_POLL_DELAY_MS = 1500;

/** Polls `getTransaction` until it leaves `NOT_FOUND` -- mirrors
 * `chain/client.ts`'s own `pollTransaction`, kept as a separate copy per
 * this story's own "No change to ... chain/" boundary. `attempts`/`delayMs`
 * are parameters (defaulting to the module's own ceiling above) so a test
 * can exercise the loop's own NOT_FOUND-retry and timeout branches in
 * milliseconds rather than minutes. Exported for exactly that reason. */
export async function defaultWaitForTransaction(
  server: rpc.Server,
  hash: string,
  attempts: number = DEFAULT_POLL_ATTEMPTS,
  delayMs: number = DEFAULT_POLL_DELAY_MS,
): Promise<rpc.Api.GetTransactionResponse> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await server.getTransaction(hash);
    if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return result;
    }
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
  throw new PaymentUnavailableError(`Timed out waiting for the balance payment transaction ${hash} to confirm.`);
}

export interface SubmitBalancePaymentResult {
  txHash: string;
}

/**
 * Relays a client-signed payment envelope over Soroban RPC's own
 * `sendTransaction`, then polls `getTransaction` until it reaches SUCCESS
 * or FAILED (the spec's own "Always" rule). Refuses (typed
 * {@link PaymentFailedError}) once the ledger itself reports the payment
 * failed; refuses (typed {@link PaymentUnavailableError}) for anything that
 * stops it reaching a final status at all -- an unreachable RPC endpoint, or
 * a poll that timed out. Never called unless the caller (`services/
 * booking.ts`'s `submitBalancePayment`) has already matched the signed
 * envelope's own hash against the one this module's own `
 * buildBalancePaymentTransaction` built for this booking.
 */
export async function submitBalancePaymentTransaction(
  signedXdr: string,
  deps: SubmitPaymentDeps = {},
): Promise<SubmitBalancePaymentResult> {
  let server: rpc.Server | undefined;
  const getServer = (): rpc.Server => {
    server ??= new rpc.Server(config.sorobanRpcUrl);
    return server;
  };
  const sendTransaction = deps.sendTransaction ?? ((tx) => getServer().sendTransaction(tx));
  const waitForTransaction = deps.waitForTransaction ?? ((hash) => defaultWaitForTransaction(getServer(), hash));

  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(signedXdr, config.stellarNetworkPassphrase);
    if (!(parsed instanceof Transaction)) {
      throw new TypeError("not a plain transaction");
    }
    tx = parsed;
  } catch {
    throw new PaymentFailedError("This transaction could not be decoded as a plain payment.");
  }

  let sendResult: rpc.Api.SendTransactionResponse;
  try {
    sendResult = await sendTransaction(tx);
  } catch (error) {
    throw new PaymentUnavailableError(
      `Could not reach the Stellar network to submit the balance payment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sendResult.status === "TRY_AGAIN_LATER") {
    // The RPC endpoint itself asked for a retry (its own mempool/rate-limit
    // condition) -- this says nothing about the transaction itself being
    // invalid, so it is never a `PaymentFailedError`.
    throw new PaymentUnavailableError(`The Stellar network asked to retry the balance payment later (status ${sendResult.status}).`);
  }
  if (sendResult.status !== "PENDING" && sendResult.status !== "DUPLICATE") {
    throw new PaymentFailedError(`The balance payment was rejected before submission (status ${sendResult.status}).`);
  }

  let finalResult: rpc.Api.GetTransactionResponse;
  try {
    finalResult = await waitForTransaction(sendResult.hash);
  } catch (error) {
    if (error instanceof PaymentFailedError || error instanceof PaymentUnavailableError) {
      throw error;
    }
    throw new PaymentUnavailableError(
      `Could not confirm the balance payment on chain: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (finalResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new PaymentFailedError(`The balance payment failed on submission (hash ${sendResult.hash}).`);
  }
  if (finalResult.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new PaymentUnavailableError(`The balance payment did not reach a final status in time (hash ${sendResult.hash}).`);
  }

  return { txHash: sendResult.hash };
}
