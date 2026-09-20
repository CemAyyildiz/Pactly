/**
 * Passkey (WebAuthn) sign-in -- the passkey pivot's replacement for the
 * wallet-signed challenge in `challenge.ts` (kept intact beside this for
 * the routes and tests that still use it). Registration creates the user
 * *and* their embedded custodial Stellar account in one step; login
 * verifies the authenticator's assertion and issues the same Pactly JWT
 * `challenge.ts` does, with the custodial public key as `sub` -- so every
 * route behind `requirePactlyAuth` keeps working unchanged.
 *
 * The ceremony itself is @simplewebauthn/server's (never hand-rolled):
 * `generate*Options` builds the browser's options and a challenge this
 * module stores (consume-once, 5-minute expiry) under a ceremony id the
 * frontend echoes back; `verify*Response` checks the response against the
 * stored challenge, `config.passkeyRpId` and `config.passkeyRpOrigins`.
 * Discoverable credentials (`residentKey: "required"`, empty
 * `allowCredentials`) so login needs no username: the authenticator picks
 * the credential and this module looks it up by id.
 */
import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { config } from "../config.js";
import { createCustodialAccount, encryptSecret } from "../custodial/keys.js";
import type { Db } from "../db/client.js";
import {
  consumeWebauthnChallenge,
  getPasskeyCredentialById,
  getUserById,
  insertUserWithCredentialSync,
  insertWebauthnChallenge,
  updatePasskeyCounter,
} from "../db/users.js";
import { issuePactlyJwt } from "./challenge.js";
import { PasskeyChallengeExpiredError, PasskeyInvalidError, PasskeyUnknownError } from "./errors.js";

const RP_NAME = "Pactly";
/** How long a ceremony's challenge stays valid between `/options` and
 * `/verify` -- generous enough for a first-time passkey prompt, short
 * enough that a leaked challenge is useless soon after. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_DISPLAY_NAME_LENGTH = 80;

export interface PasskeyDeps {
  /** Epoch milliseconds -- defaults to `Date.now()`. A test's seam for
   * challenge expiry. */
  now?: () => number;
}

function nowMs(deps: PasskeyDeps): number {
  return deps.now ? deps.now() : Date.now();
}

function cleanDisplayName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH) : "";
}

export interface RegistrationOptionsResult {
  registrationId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

/** Step one of sign-up: options for `navigator.credentials.create()`, plus
 * the ceremony id the verify step must echo back. The user id is allocated
 * here (WebAuthn's `user.id` must be stable and opaque) and carried on the
 * challenge row until verify creates the row for real. */
export async function beginPasskeyRegistration(
  db: Db,
  input: { displayName?: unknown },
  deps: PasskeyDeps = {},
): Promise<RegistrationOptionsResult> {
  const userId = randomUUID();
  const displayName = cleanDisplayName(input.displayName);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: config.passkeyRpId,
    userID: new TextEncoder().encode(userId),
    userName: displayName || `pactly-${userId.slice(0, 8)}`,
    userDisplayName: displayName || "Pactly user",
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });
  const registrationId = randomUUID();
  await insertWebauthnChallenge(db, {
    id: registrationId,
    kind: "register",
    challenge: options.challenge,
    userId,
    displayName,
    expiresAt: nowMs(deps) + CHALLENGE_TTL_MS,
  });
  return { registrationId, options };
}

export interface PasskeySession {
  token: string;
  walletAddress: string;
}

/** Step two of sign-up: verifies the authenticator's attestation against
 * the stored challenge, then creates the user, their custodial account and
 * the credential together, and signs them in. */
export async function finishPasskeyRegistration(
  db: Db,
  input: { registrationId: string; response: unknown },
  deps: PasskeyDeps = {},
): Promise<PasskeySession> {
  const challenge = await consumeWebauthnChallenge(db, input.registrationId, "register");
  if (!challenge || challenge.expiresAt <= nowMs(deps)) {
    throw new PasskeyChallengeExpiredError();
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.passkeyRpOrigins,
      expectedRPID: config.passkeyRpId,
      requireUserVerification: false,
    });
  } catch {
    throw new PasskeyInvalidError();
  }
  if (!verification.verified) {
    throw new PasskeyInvalidError();
  }
  const { credential } = verification.registrationInfo;

  const keypair = createCustodialAccount();
  const walletAddress = keypair.publicKey();
  const createdAt = nowMs(deps);
  const userId = challenge.userId ?? randomUUID();
  try {
    insertUserWithCredentialSync(
      db,
      {
        id: userId,
        displayName: challenge.displayName ?? "",
        walletAddress,
        encryptedSecret: encryptSecret(keypair.secret()),
        createdAt,
      },
      {
        id: credential.id,
        userId,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? [],
        createdAt,
      },
    );
  } catch {
    // A credential id that already exists (the same authenticator
    // registered twice) -- refused as invalid rather than surfacing the
    // constraint failure; the user can just sign in with it instead.
    throw new PasskeyInvalidError();
  }

  return { token: await issuePactlyJwt(walletAddress), walletAddress };
}

export interface LoginOptionsResult {
  loginId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

/** Step one of sign-in: options for `navigator.credentials.get()` with no
 * `allowCredentials` (discoverable credentials), plus the ceremony id. */
export async function beginPasskeyLogin(db: Db, deps: PasskeyDeps = {}): Promise<LoginOptionsResult> {
  const options = await generateAuthenticationOptions({
    rpID: config.passkeyRpId,
    userVerification: "preferred",
    allowCredentials: [],
  });
  const loginId = randomUUID();
  await insertWebauthnChallenge(db, {
    id: loginId,
    kind: "login",
    challenge: options.challenge,
    expiresAt: nowMs(deps) + CHALLENGE_TTL_MS,
  });
  return { loginId, options };
}

/** Step two of sign-in. Order matters for the contract: the credential
 * lookup runs first, so an unregistered passkey is a
 * {@link PasskeyUnknownError} (the frontend offers sign-up) regardless of
 * the challenge's state; everything after that -- a consumed or expired
 * challenge, a bad signature, a wrong origin -- is one
 * {@link PasskeyInvalidError}. On success the credential's counter
 * advances and the user's custodial wallet gets a Pactly JWT. */
export async function finishPasskeyLogin(
  db: Db,
  input: { loginId: string; response: unknown },
  deps: PasskeyDeps = {},
): Promise<PasskeySession> {
  const response = input.response as AuthenticationResponseJSON | undefined;
  const credentialId = typeof response?.id === "string" ? response.id : undefined;
  if (!credentialId) {
    throw new PasskeyInvalidError();
  }
  const credential = await getPasskeyCredentialById(db, credentialId);
  if (!credential) {
    throw new PasskeyUnknownError();
  }

  const challenge = await consumeWebauthnChallenge(db, input.loginId, "login");
  if (!challenge || challenge.expiresAt <= nowMs(deps)) {
    throw new PasskeyInvalidError();
  }

  let transports: string[] = [];
  try {
    const parsed: unknown = JSON.parse(credential.transports);
    if (Array.isArray(parsed)) transports = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    transports = [];
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.passkeyRpOrigins,
      expectedRPID: config.passkeyRpId,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
        counter: credential.counter,
        transports,
      },
      requireUserVerification: false,
    });
  } catch {
    throw new PasskeyInvalidError();
  }
  if (!verification.verified) {
    throw new PasskeyInvalidError();
  }

  const user = await getUserById(db, credential.userId);
  if (!user) {
    // A credential whose user row is gone -- unreachable with the FK on,
    // guarded anyway rather than issuing a JWT for nobody.
    throw new PasskeyUnknownError();
  }
  await updatePasskeyCounter(db, credential.id, verification.authenticationInfo.newCounter);
  return { token: await issuePactlyJwt(user.walletAddress), walletAddress: user.walletAddress };
}
