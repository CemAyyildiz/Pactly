/**
 * Thin wrappers around Horizon: load an account (or learn it does not exist
 * yet), fund one through friendbot, and add a trustline. The decision of
 * whether a step is needed lives in `decisions.ts`; this module only performs
 * the network call once that decision says to.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  NotFoundError,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { TransactionSource } from "@stellar/stellar-sdk";

// Horizon proxies friendbot at `<serverURL>/friendbot`, so the friendbot URL
// is not separately configurable — it is a function of which Horizon this
// command talks to, and this command only ever talks to testnet (see AD-10
// and the "No mainnet" constraint).
const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";

export function horizonServer(): Horizon.Server {
  return new Horizon.Server(HORIZON_TESTNET_URL);
}

/** `undefined` when the account does not exist on the ledger yet. */
export async function loadAccountIfExists(
  server: Horizon.Server,
  publicKey: string,
): Promise<Horizon.AccountResponse | undefined> {
  try {
    return await server.loadAccount(publicKey);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** The single lookup `loadAccountWithRetry` retries, so a test can stub it
 * without a real Horizon-backed server. Defaults to the real lookup. */
export type LoadAccount = (publicKey: string) => Promise<Horizon.AccountResponse | undefined>;

/**
 * Horizon can lag a moment behind Friendbot's own confirmation, so a freshly
 * funded account can briefly still 404. Retries a few times with a short
 * delay rather than treating that lag as friendbot having failed.
 */
export async function loadAccountWithRetry(
  server: Horizon.Server,
  publicKey: string,
  attempts = 5,
  delayMs = 1000,
  load: LoadAccount = (key) => loadAccountIfExists(server, key),
): Promise<Horizon.AccountResponse | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const account = await load(publicKey);
    if (account) {
      return account;
    }
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
  return undefined;
}

interface HorizonErrorData {
  detail?: string;
  title?: string;
  extras?: { result_codes?: { operations?: string[]; transaction?: string } };
}

function horizonErrorData(error: unknown): HorizonErrorData | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { response?: { data?: HorizonErrorData } }).response?.data;
}

/** Horizon's own reason for a rejection — `extras.result_codes`' detail when
 * present, since that is more specific than the generic HTTP status message
 * `error.message` would otherwise give ("Request failed with status 400"). */
function horizonErrorReason(error: unknown): string {
  const data = horizonErrorData(error);
  const detail = data?.detail ?? data?.title;
  const operations = data?.extras?.result_codes?.operations;
  const codes = operations && operations.length > 0 ? ` (${operations.join(", ")})` : "";
  if (detail) return `${detail}${codes}`;
  return error instanceof Error ? error.message : String(error);
}

export class FriendbotError extends Error {}

/** The request friendbot funding makes, so a test can stub it. Defaults to the
 * real call, so no caller outside the tests needs to pass this. */
export type FriendbotCall = () => Promise<unknown>;

export async function fundViaFriendbot(
  server: Horizon.Server,
  publicKey: string,
  call: FriendbotCall = () => server.friendbot(publicKey).call(),
): Promise<void> {
  try {
    await call();
  } catch (error) {
    // Horizon reports funding an already-existing account as a failed
    // create-account operation, not as success — but for this command that
    // outcome means the same thing "already funded" does everywhere else:
    // there is nothing left to do.
    if (isAlreadyFundedError(error)) {
      return;
    }
    throw new FriendbotError(`Friendbot refused to fund ${publicKey}: ${horizonErrorReason(error)}`);
  }
}

function isAlreadyFundedError(error: unknown): boolean {
  const data = horizonErrorData(error);
  if (!data) return false;
  const operations = data.extras?.result_codes?.operations ?? [];
  if (operations.some((code) => code.includes("already_exist"))) {
    return true;
  }
  return `${data.detail ?? ""} ${data.title ?? ""}`.toLowerCase().includes("already");
}

export class TrustlineError extends Error {}

/** The submission `addTrustline` performs, so a test can stub it without a
 * real network-backed account. Defaults to the real call. */
export type SubmitTransaction = (transaction: Transaction) => Promise<unknown>;

export async function addTrustline(
  server: Horizon.Server,
  account: TransactionSource,
  signer: Keypair,
  asset: Asset,
  networkPassphrase: string,
  submit: SubmitTransaction = (transaction) => server.submitTransaction(transaction),
): Promise<void> {
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(30)
    .build();
  transaction.sign(signer);
  try {
    await submit(transaction);
  } catch (error) {
    throw new TrustlineError(
      `Could not add the ${asset.getCode()} trustline for ${signer.publicKey()}: ${horizonErrorReason(error)}`,
    );
  }
}
