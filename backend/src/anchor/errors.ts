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
