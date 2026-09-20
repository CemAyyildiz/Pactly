/**
 * Typed errors for the embedded custodial account (`keys.ts`, `funding.ts`)
 * -- a route only ever sees one of these, never a raw stellar-sdk or
 * node:crypto failure.
 */

/** The wallet a caller's JWT names has no `users` row -- a legacy
 * wallet-login JWT, or a wallet this backend never created. There is no
 * secret to sign with, so nothing can be signed on its behalf. */
export class NoCustodialAccountError extends Error {
  constructor(message = "No Pactly account holds this wallet.") {
    super(message);
    this.name = "NoCustodialAccountError";
  }
}

/** The XDR handed to the signer could not be decoded as a transaction
 * envelope on this network. */
export class InvalidXdrError extends Error {
  constructor(message = "unsignedXdr is not a valid transaction envelope.") {
    super(message);
    this.name = "InvalidXdrError";
  }
}

/** Friendbot refused (or could not be reached) while funding a custodial
 * account. Best-effort: `ensureAccountReady` swallows this and tries again
 * on the next call; it is typed so a caller *can* tell it apart. */
export class AccountFundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountFundingError";
  }
}
