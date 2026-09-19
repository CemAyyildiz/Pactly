/**
 * Typed application errors for every way a contract call can fail, and the
 * translation from the escrow contract's own error catalogue
 * (`contracts/escrow/src/error.rs`) into one of them. This is the piece
 * AD-8 exists for: a caller of `client.ts` never sees a raw Soroban host
 * error string or numeric code, only one of these.
 */

/** `ESCROW_CONTRACT_ID` is empty -- the contract is not deployed yet, or
 * the deploy step's output was never pasted into `.env`. Refused before any
 * network access, per this story's own constraint. */
export class ChainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainConfigError";
  }
}

/**
 * One-to-one with `contracts/escrow/src/error.rs`'s `Error` enum. Discriminant
 * numbers are the contract's own (1-9) and must never be renumbered, since
 * `error.rs`'s own doc comment makes the same promise on the Rust side.
 */
export const CONTRACT_ERROR_CONDITIONS = [
  "AlreadyInitialized",
  "NotInitialized",
  "BookingExists",
  "BookingNotFound",
  "InvalidAmount",
  "InvalidState",
  "InvalidDeadline",
  "InvalidParties",
  "TooEarly",
] as const;

export type ContractErrorCondition = (typeof CONTRACT_ERROR_CONDITIONS)[number];

const CONTRACT_ERROR_BY_CODE: Readonly<Record<number, ContractErrorCondition>> = {
  1: "AlreadyInitialized",
  2: "NotInitialized",
  3: "BookingExists",
  4: "BookingNotFound",
  5: "InvalidAmount",
  6: "InvalidState",
  7: "InvalidDeadline",
  8: "InvalidParties",
  9: "TooEarly",
};

/** The condition named in plain language, for the error message a caller
 * (eventually an API's `message` field) sees -- never the bare enum name
 * alone, and never the numeric code. */
const CONTRACT_ERROR_DESCRIPTIONS: Readonly<Record<ContractErrorCondition, string>> = {
  AlreadyInitialized: "the escrow contract already has an admin",
  NotInitialized: "the escrow contract has not been initialized yet",
  BookingExists: "a booking already exists under that booking id",
  BookingNotFound: "no booking exists under that booking id",
  InvalidAmount: "the deposit amount must be a positive integer",
  InvalidState: "the booking is not in a state that allows this action",
  InvalidDeadline: "the cancellation deadline is outside the range the contract accepts",
  // Narrowed to what the contract actually checks (retrospective F-10):
  // professional == client, or professional == the escrow contract itself.
  InvalidParties: "the professional and the client must be different accounts",
  TooEarly: "the free-cancellation window has not closed yet",
};

/** A contract call the chain itself refused -- `.condition` names exactly
 * which of the nine conditions in `error.rs`, so a caller can branch on it
 * without parsing `.message`. */
export class ChainContractError extends Error {
  constructor(public readonly condition: ContractErrorCondition) {
    super(`Escrow contract refused the call: ${CONTRACT_ERROR_DESCRIPTIONS[condition]} (${condition}).`);
    this.name = "ChainContractError";
  }
}

/** Everything that is not a contract-level refusal: a host error this
 * catalogue does not recognize, a simulation that failed for a
 * non-contract reason, or a transaction that passed simulation and still
 * failed on submission. Still typed, still never a raw string handed
 * straight to a caller. */
export class ChainRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainRequestError";
  }
}

const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

/** Pulls a contract error's numeric code out of a Soroban host error
 * string (as returned by `simulateTransaction`'s `error` field). Pure text
 * matching -- no XDR, no network -- so it is unit-testable on its own, in
 * addition to (never instead of) the client functions that call it. */
export function parseContractErrorCode(message: string): number | undefined {
  const match = CONTRACT_ERROR_PATTERN.exec(message);
  if (!match) return undefined;
  return Number(match[1]);
}

export function contractErrorConditionForCode(code: number): ContractErrorCondition | undefined {
  return CONTRACT_ERROR_BY_CODE[code];
}

/** Translates a raw Soroban host error message into the typed error a
 * chain client function should throw: a {@link ChainContractError} naming
 * the condition when the message describes one of the contract's own nine
 * errors, a {@link ChainRequestError} for anything else (an unrecognized
 * code, a host trap, a network-shaped failure). */
export function translateHostErrorMessage(message: string): ChainContractError | ChainRequestError {
  const code = parseContractErrorCode(message);
  if (code === undefined) {
    return new ChainRequestError(`Escrow contract call failed: ${message}`);
  }
  const condition = contractErrorConditionForCode(code);
  if (!condition) {
    return new ChainRequestError(`Escrow contract call failed with an unrecognized contract error code ${code}.`);
  }
  return new ChainContractError(condition);
}
