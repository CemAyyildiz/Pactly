/**
 * Typed errors for the anchor's side of this story: discovering its
 * `stellar.toml` (SEP-1) and running its real SEP-10 exchange. Never the
 * Pactly-side errors in `../auth/errors.ts`.
 */

/** `stellar.toml` could not be fetched or parsed, or was missing a field
 * this backend needs -- always names the domain involved, per the I/O
 * matrix ("Meaningful, typed error naming the domain"). Nothing proceeds to
 * the anchor's SEP-10 exchange when this is thrown. */
export class AnchorDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorDiscoveryError";
  }
}

/** The anchor's own SEP-10 exchange did not complete: it rejected the
 * challenge request, rejected the signed challenge, or returned a response
 * this backend cannot make sense of. Carries the anchor's own reason in its
 * message where the anchor supplied one (I/O matrix: "surfacing the
 * anchor's own reason"). Nothing is stored server-side when this is
 * thrown. */
export class AnchorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorAuthError";
  }
}

/** A caller-supplied signer does not match the wallet address the anchor
 * exchange (or the cache it feeds) was asked for -- refused before any
 * network access, the same discipline `chain/client.ts`'s typed errors
 * established. */
export class AnchorSignerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorSignerMismatchError";
  }
}

/** Story 2.2: the anchor's SEP-38 price endpoint could not be reached, or
 * answered with something other than a usable price (unreachable,
 * non-200, or a response missing the fields the quote depends on). Maps to
 * `503 QUOTE_UNAVAILABLE` -- the USDC amount still shows, only the fiat
 * equivalent line is replaced by a plain sentence (this story's own
 * "Always" rule: a quote failure never blocks the flow). */
export class AnchorQuoteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorQuoteUnavailableError";
  }
}

/** Story 2.2: the anchor is reachable but does not offer this asset/fiat
 * pair (its `sep38/info` never advertises the sell asset or a fiat
 * currency alongside it). Distinct from unavailable -- this is a
 * configuration/support fact, not a transient failure -- and maps to its
 * own `409 QUOTE_UNSUPPORTED`. */
export class AnchorQuoteUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorQuoteUnsupportedError";
  }
}

/** Story 2.4: the anchor's SEP-12 customer endpoint refused the wallet or
 * returned a status this backend cannot treat as approved. Maps to
 * `502 ANCHOR_KYC_FAILED`. */
export class AnchorKycError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorKycError";
  }
}

/** Story 2.4: the anchor's SEP-6 deposit call (open, poll, or simulate)
 * failed in a way that is the deposit itself going wrong -- a refused
 * request, an `error` status, or a body this backend cannot use. Maps to
 * `502 ANCHOR_DEPOSIT_FAILED`. */
export class AnchorDepositError extends Error {
  readonly simulate: boolean;
  constructor(message: string, options: { simulate?: boolean } = {}) {
    super(message);
    this.name = "AnchorDepositError";
    this.simulate = options.simulate === true;
  }
}

/** Story 2.4: the anchor (or a required SEP endpoint on it) could not be
 * reached, or its `stellar.toml` does not declare a server this call
 * needs. Maps to `503 ANCHOR_UNAVAILABLE`. Distinct from a deposit that
 * opened and then failed. */
export class AnchorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorUnavailableError";
  }
}

/** Story 2.4: the booking's deposit, converted at the anchor's own
 * indicative rate, sits outside the advertised min/max. Maps to
 * `409 AMOUNT_OUT_OF_RANGE` with `details.min/max/currency`. */
export class AmountOutOfRangeError extends Error {
  readonly min: string;
  readonly max: string;
  readonly currency: string;
  constructor(min: string, max: string, currency: string) {
    super(`This amount is outside the ${min}–${max} ${currency} range for a local-currency transfer.`);
    this.name = "AmountOutOfRangeError";
    this.min = min;
    this.max = max;
    this.currency = currency;
  }
}

/** Story 2.4: a SEP-6/12 call was attempted without a still-valid cached
 * anchor JWT. Maps to `401 ANCHOR_AUTH_REQUIRED` so the client can run the
 * challenge flow. */
export class AnchorAuthRequiredError extends Error {
  constructor(message = "Sign in with the anchor to continue.") {
    super(message);
    this.name = "AnchorAuthRequiredError";
  }
}
