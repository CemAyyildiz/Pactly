/**
 * The embedded custodial Stellar account (passkey pivot): end users never
 * see a wallet, so this backend holds each user's Stellar secret seed --
 * encrypted at rest under AES-256-GCM -- and signs on their behalf. The
 * account's public key is the user's `walletAddress` everywhere else in the
 * codebase (the Pactly JWT's `sub`, every `*_wallet_address` column), so
 * nothing downstream knows or cares that the key lives here.
 *
 * Key material: sha256 of `PACTLY_CUSTODIAL_ENCRYPTION_KEY`, or -- when that
 * is unset, so local dev keeps working with no new variable -- sha256 of
 * `PACTLY_AUTH_SIGNING_SECRET` under a fixed prefix (domain-separated from
 * the same secret's JWT and SEP-10 uses in `../auth/challenge.ts`). A fresh
 * random IV per encryption; the GCM tag is stored beside the ciphertext.
 * Only this module ever calls `decryptSecret`, and only inside
 * {@link signXdrForWallet}: a decrypted seed never leaves this file and
 * never enters a log line or a response body.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { FeeBumpTransaction, Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { getUserByWalletAddress } from "../db/users.js";
import { InvalidXdrError, NoCustodialAccountError } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
/** Versioned so a future key/format change can tell old rows apart. */
const FORMAT_VERSION = "v1";

let cachedKey: Buffer | undefined;
function encryptionKey(): Buffer {
  if (!cachedKey) {
    const material = config.custodialEncryptionKey
      ? config.custodialEncryptionKey
      : `pactly-custodial-encryption-key:${config.pactlyAuthSigningSecret}`;
    cachedKey = createHash("sha256").update(material).digest();
  }
  return cachedKey;
}

/** A brand-new random Stellar keypair for a newly registered user. */
export function createCustodialAccount(): Keypair {
  return Keypair.random();
}

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function encryptSecret(secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Inverse of {@link encryptSecret}. Throws a plain `Error` on a malformed
 * blob or a failed GCM tag check (a wrong key, or a tampered row) -- a
 * programming/operations error, not a user-facing one. */
export function decryptSecret(encoded: string): string {
  const [version, ivPart, tagPart, ciphertextPart] = encoded.split(".");
  if (version !== FORMAT_VERSION || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Malformed encrypted secret.");
  }
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Decodes a base64 envelope for this network, or throws
 * {@link InvalidXdrError}. Both plain and fee-bump envelopes are accepted --
 * `TransactionBuilder.fromXDR` returns whichever the XDR is, and both
 * expose the same `sign(...)`/`toXDR()` surface. */
function parseEnvelope(unsignedXdr: string): Transaction | FeeBumpTransaction {
  try {
    const parsed = TransactionBuilder.fromXDR(unsignedXdr, config.stellarNetworkPassphrase);
    if (parsed instanceof Transaction || parsed instanceof FeeBumpTransaction) {
      return parsed;
    }
  } catch {
    // fall through to the typed error below
  }
  throw new InvalidXdrError();
}

/**
 * Signs `unsignedXdr` with the custodial key of the user who owns
 * `walletAddress`, returning the signed base64 XDR. Refuses with
 * {@link NoCustodialAccountError} when no user owns that wallet (a legacy
 * wallet-login JWT) and {@link InvalidXdrError} when the envelope does not
 * decode -- the XDR is checked *before* any secret is decrypted, so a bad
 * request never reaches the key at all.
 */
export async function signXdrForWallet(db: Db, walletAddress: string, unsignedXdr: string): Promise<string> {
  const user = await getUserByWalletAddress(db, walletAddress);
  if (!user) {
    throw new NoCustodialAccountError();
  }
  const envelope = parseEnvelope(unsignedXdr);
  if (user.encryptedSecret === "passkey-kit") {
    throw new NoCustodialAccountError(
      "This passkey session is out of date. Sign out and continue with passkey again so the deposit rail can be created.",
    );
  }
  const keypair = Keypair.fromSecret(decryptSecret(user.encryptedSecret));
  envelope.sign(keypair);
  return envelope.toXDR();
}

/** Test-only: forget the derived key so a config change is picked up. */
export function resetCustodialKeyCacheForTests(): void {
  cachedKey = undefined;
}
