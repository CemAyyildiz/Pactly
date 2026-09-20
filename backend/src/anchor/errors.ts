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
