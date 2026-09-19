/**
 * The single escrow contract client (AD-8): every contract call in this
 * codebase -- `createBooking`, `release`, `cancelByProfessional`,
 * `cancelByClient`, `claimNoShow` -- goes through `invoke` below, and no
 * other module opens an RPC connection or builds a Soroban transaction.
 *
 * Network access sits entirely behind `ChainCallDeps`: every stage
 * (`getAccount`, `simulate`, `send`, `waitForTransaction`) is an injected
 * function that defaults to the real `@stellar/stellar-sdk` RPC call. A
 * caller that does not override a stage gets the real network; a test that
 * overrides every stage never touches it -- which is the only reason this
 * story is verifiable at all while `ESCROW_CONTRACT_ID` is empty and the
 * contract is not deployed.
 *
 * A contract's own rejection is caught at simulation time and translated
 * there (`errors.ts`): Soroban actually executes the invocation during
 * `simulateTransaction`, so every one of the nine conditions in
 * `error.rs` is already visible before anything is signed or sent. Signing
 * and sending only ever run against a simulation that already succeeded,
 * so a `ChainRequestError` thrown after that point (submission failed,
 * or timed out reaching a final status) reports a host/network failure,
 * never a contract condition.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { ChainConfigError, ChainRequestError, translateHostErrorMessage } from "./errors.js";

export interface ChainCallDeps {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  getAccount: (publicKey: string) => Promise<Account>;
  simulate: (tx: Transaction) => Promise<rpc.Api.SimulateTransactionResponse>;
  send: (tx: Transaction) => Promise<rpc.Api.SendTransactionResponse>;
  waitForTransaction: (hash: string) => Promise<rpc.Api.GetTransactionResponse>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Polls `getTransaction` until it leaves `NOT_FOUND`. This is the only
 * piece of the real pipeline complex enough to want its own function
 * (rather than an inline arrow in {@link defaultDeps}); it is still never
 * called unless nothing overrides `waitForTransaction`. */
export async function pollTransaction(
  server: rpc.Server,
  hash: string,
  attempts = 10,
  delayMs = 1500,
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
  throw new ChainRequestError(`Timed out waiting for transaction ${hash} to leave the NOT_FOUND state.`);
}

function defaultDeps(overrides: Partial<ChainCallDeps>): ChainCallDeps {
  const contractId = overrides.contractId ?? config.escrowContractId;
  const rpcUrl = overrides.rpcUrl ?? config.sorobanRpcUrl;
  const networkPassphrase = overrides.networkPassphrase ?? config.stellarNetworkPassphrase;
  // Constructed lazily, and only once: a caller who overrides every stage
  // (every unit test) never causes this to be built, let alone contacted.
  let server: rpc.Server | undefined;
  const getServer = (): rpc.Server => {
    server ??= new rpc.Server(rpcUrl);
    return server;
  };
  return {
    contractId,
    rpcUrl,
    networkPassphrase,
    getAccount: overrides.getAccount ?? ((publicKey) => getServer().getAccount(publicKey)),
    simulate: overrides.simulate ?? ((tx) => getServer().simulateTransaction(tx)),
    send: overrides.send ?? ((tx) => getServer().sendTransaction(tx)),
    waitForTransaction: overrides.waitForTransaction ?? ((hash) => pollTransaction(getServer(), hash)),
  };
}

export interface ContractCallResult {
  hash: string;
}

/**
 * Builds, simulates, signs and submits one call to the escrow contract.
 * Every one of the five exported functions below is a thin wrapper over
 * this -- the one place error translation, the empty-contract-id refusal,
 * and the simulate/sign/send pipeline live, per AD-8.
 */
async function invoke(
  method: string,
  scArgs: ReturnType<typeof nativeToScVal>[],
  signer: Keypair,
  overrides: Partial<ChainCallDeps>,
): Promise<ContractCallResult> {
  const deps = defaultDeps(overrides);

  if (!deps.contractId) {
    throw new ChainConfigError(
      "ESCROW_CONTRACT_ID is empty. Deploy the escrow contract and set ESCROW_CONTRACT_ID " +
        "before making a contract call (see `npm run setup:testnet`).",
    );
  }

  const contract = new Contract(deps.contractId);
  const sourceAccount = await deps.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: deps.networkPassphrase })
    .addOperation(contract.call(method, ...scArgs))
    .setTimeout(30)
    .build();

  const simulation = await deps.simulate(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw translateHostErrorMessage(simulation.error);
  }

  const prepared = rpc.assembleTransaction(tx, simulation).build();
  prepared.sign(signer);

  const sendResult = await deps.send(prepared);
  if (sendResult.status !== "PENDING" && sendResult.status !== "DUPLICATE") {
    throw new ChainRequestError(
      `Escrow contract call "${method}" was rejected before submission (status ${sendResult.status}).`,
    );
  }

  const finalResult = await deps.waitForTransaction(sendResult.hash);
  if (finalResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new ChainRequestError(
      `Escrow contract call "${method}" passed simulation but failed on submission (hash ${sendResult.hash}).`,
    );
  }
  if (finalResult.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new ChainRequestError(
      `Escrow contract call "${method}" did not reach a final status in time (hash ${sendResult.hash}).`,
    );
  }

  return { hash: sendResult.hash };
}

/** 32 lowercase hex characters -- the wire shape this backend stores a
 * `BytesN<16>` booking id as (see `db/schema.ts`'s `bookings.id`). */
const BOOKING_ID_PATTERN = /^[0-9a-f]{32}$/;

function bookingIdToBytes(bookingId: string): Uint8Array {
  if (!BOOKING_ID_PATTERN.test(bookingId)) {
    throw new TypeError(`bookingId must be 32 lowercase hex characters (16 bytes), got "${bookingId}"`);
  }
  return Uint8Array.from(Buffer.from(bookingId, "hex"));
}

/** An integer string in the asset's smallest unit (AD-7) -- never a float,
 * never accepted as one. */
function parseAmount(amount: string): bigint {
  if (!/^\d+$/.test(amount)) {
    throw new TypeError(`amount must be a non-negative integer string, got "${amount}"`);
  }
  return BigInt(amount);
}

function scBookingId(bookingId: string) {
  return nativeToScVal(bookingIdToBytes(bookingId), { type: "bytes" });
}

/** UTC epoch seconds -- a non-negative safe integer, same validate-before-use
 * pattern as {@link parseAmount} and {@link bookingIdToBytes}. Without this,
 * a non-finite `cancelDeadline` (e.g. `NaN`) would reach `BigInt()` inside
 * `Math.trunc(...)` and throw a bare, untyped `RangeError` instead of one of
 * this module's typed errors. */
function parseCancelDeadline(cancelDeadline: number): bigint {
  if (!Number.isSafeInteger(cancelDeadline) || cancelDeadline < 0) {
    throw new TypeError(
      `cancelDeadline must be a non-negative safe integer (UTC epoch seconds), got ${cancelDeadline}`,
    );
  }
  return BigInt(cancelDeadline);
}

export interface CreateBookingArgs {
  /** 32 lowercase hex characters (16 bytes) -- generated off chain per AD-13. */
  bookingId: string;
  /** The professional's Stellar account (G...). */
  professional: string;
  /** The client's Stellar account (G...); must also be the transaction's
   * signer, since `create_booking` requires the client's own auth. */
  client: string;
  /** The deposit's token contract. */
  token: string;
  /** Integer string, smallest unit (AD-7). */
  amount: string;
  /** UTC epoch seconds. */
  cancelDeadline: number;
}

/** Locks a booking's deposit. Requires `signer` to be the client named in
 * `args.client` -- the contract's own `require_auth` check, not merely a
 * convention here. */
export function createBooking(
  args: CreateBookingArgs,
  signer: Keypair,
  overrides: Partial<ChainCallDeps> = {},
): Promise<ContractCallResult> {
  const scArgs = [
    scBookingId(args.bookingId),
    new Address(args.professional).toScVal(),
    new Address(args.client).toScVal(),
    new Address(args.token).toScVal(),
    nativeToScVal(parseAmount(args.amount), { type: "i128" }),
    nativeToScVal(parseCancelDeadline(args.cancelDeadline), { type: "u64" }),
  ];
  return invoke("create_booking", scArgs, signer, overrides);
}

/** Pays a locked deposit to the professional. Requires `signer` to be the
 * booking's own client (the contract reads the record to learn who, so an
 * unknown id needs no signature at all -- see `lib.rs`). */
export function release(
  bookingId: string,
  signer: Keypair,
  overrides: Partial<ChainCallDeps> = {},
): Promise<ContractCallResult> {
  return invoke("release", [scBookingId(bookingId)], signer, overrides);
}

/** Refunds the client because the professional called the session off.
 * Requires `signer` to be the booking's own professional. */
export function cancelByProfessional(
  bookingId: string,
  signer: Keypair,
  overrides: Partial<ChainCallDeps> = {},
): Promise<ContractCallResult> {
  return invoke("cancel_by_professional", [scBookingId(bookingId)], signer, overrides);
}

/** Refunds or forfeits the deposit depending on the ledger clock. Requires
 * `signer` to be the booking's own client. */
export function cancelByClient(
  bookingId: string,
  signer: Keypair,
  overrides: Partial<ChainCallDeps> = {},
): Promise<ContractCallResult> {
  return invoke("cancel_by_client", [scBookingId(bookingId)], signer, overrides);
}

/** Claims a forfeited deposit after the free-cancellation window has
 * closed. Requires `signer` to be the booking's own professional. */
export function claimNoShow(
  bookingId: string,
  signer: Keypair,
  overrides: Partial<ChainCallDeps> = {},
): Promise<ContractCallResult> {
  return invoke("claim_no_show", [scBookingId(bookingId)], signer, overrides);
}

// Exported for tests that want to build a fake account without a real
// network round trip (e.g. `new Account(publicKey, "1")`).
export { Account, Keypair, scValToNative };
