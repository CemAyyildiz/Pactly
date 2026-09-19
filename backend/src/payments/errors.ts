/**
 * Typed application errors for Story 3.7's own plain Stellar payment path
 * (`payments/stellar.ts`) -- mirrors `chain/errors.ts`'s shape: a caller
 * never sees a raw Soroban host error string or a bare `fetch` failure,
 * only one of these two. Distinct from `escrow/trustless-work/errors.ts` on
 * purpose (AD-3): the balance payment never goes through the Trustless Work
 * adapter, so its own failures are never one of *that* module's error
 * classes either.
 */

/** The transaction reached a final, non-recoverable outcome: it failed
 * simulation/submission, or the ledger itself reports `FAILED`. Retrying
 * the exact same signed envelope will not help -- the caller must build a
 * fresh transaction (a new `buildBalancePayment` call) if they want to try
 * again. */
export class PaymentFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentFailedError";
  }
}

/** Everything that stopped the payment from reaching a final SUCCESS/FAILED
 * status: the RPC endpoint was unreachable, or polling timed out before a
 * final status arrived. Unlike {@link PaymentFailedError}, this says
 * nothing about whether the transaction will still land -- the caller's own
 * copy is untouched either way. */
export class PaymentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentUnavailableError";
  }
}
