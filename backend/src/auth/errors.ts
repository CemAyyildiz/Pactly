/**
 * Typed errors for Pactly's own SEP-10-shaped login (AD-5) -- the challenge
 * this backend builds, signs and verifies itself under `PACTLY_HOME_DOMAIN`,
 * and the Pactly JWT that login produces. Never the anchor's side (see
 * `../anchor/errors.ts` for that). A caller of `challenge.ts` never sees a
 * raw stellar-sdk `InvalidChallengeError` or a raw `jose` error, only one of
 * these -- the same discipline `chain/errors.ts` established for the
 * contract client.
 */

/** The wallet named by the challenge is not who signed it -- covers both
 * "no client signature at all" and "signed by a different key," on purpose:
 * the I/O matrix requires the two to be indistinguishable to a caller
 * ("same shape as no signature"), so this carries no detail that would let
 * one be told apart from the other. */
export class PactlyChallengeInvalidError extends Error {
  constructor(message = "The challenge was not signed by the wallet it was issued to.") {
    super(message);
    this.name = "PactlyChallengeInvalidError";
  }
}

/** The challenge was well-formed and server-signed but is past its validity
 * window. Kept distinct from {@link PactlyChallengeInvalidError} because the
 * I/O matrix asks this one case, unlike the wrong-signer case, to name the
 * expiry. */
export class PactlyChallengeExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PactlyChallengeExpiredError";
  }
}

/** A `publicKey` that is not a syntactically valid Stellar ed25519 account
 * id -- refused before a challenge is ever built or read. */
export class PactlyInvalidAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PactlyInvalidAccountError";
  }
}

/** Every way a Pactly JWT can fail to verify -- missing, expired or
 * tampered -- collapsed into one shape on purpose (I/O matrix: "same shape
 * as expired ... no signature-forgery oracle"). Never carries the
 * underlying `jose` failure reason in its message. */
export class PactlyJwtError extends Error {
  constructor(message = "The session token is missing, expired, or invalid.") {
    super(message);
    this.name = "PactlyJwtError";
  }
}
