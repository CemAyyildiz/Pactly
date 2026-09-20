/**
 * Sign-in and signing for Pactly -- passkeys, not wallets.
 *
 * Wallets are gone. Pactly's users are barbers, therapists and their
 * clients, and the pivot decision is that none of them should ever see a
 * crypto wallet, a seed phrase or a browser extension. Sign-in is a passkey
 * (WebAuthn: face, fingerprint or device PIN), and every Stellar signature
 * the product needs is made server-side by a custodial key the backend
 * holds for that account. The Stellar address is still returned as
 * `walletAddress` -- to the user it is nothing more than an opaque customer
 * id (shown shortened in the provider panel and admin rows), and every
 * importer keeps compiling against the same `Session` shape.
 *
 * The module keeps its old name and public surface (`getSession`,
 * `signOut`, `signIn`, `signXdr`, `Session`) so the twelve files importing
 * it did not have to change; only the internals moved from the Stellar
 * Wallets Kit to `@simplewebauthn/browser` plus `POST /me/sign`.
 *
 * The session lives in `sessionStorage` (cleared on tab close -- never
 * `localStorage`, so a shared machine never carries a session forward).
 */
import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

import { ApiError, apiPost } from "../api/client";

const SESSION_STORAGE_KEY = "pactly.session";

export interface Session {
  token: string;
  /** The account's Stellar address, held custodially by the backend. An
   * opaque customer id as far as the user is concerned. */
  walletAddress: string;
}

/**
 * Thrown when the user (or the browser on their behalf) closed or timed
 * out the passkey prompt without finishing it -- callers show it as neutral
 * information ("You didn't finish signing in."), never as a warning, and
 * distinguish it from a network drop or a backend rejection ({@link ApiError}).
 */
export class SignInCancelledError extends Error {
  constructor() {
    super("The passkey prompt was closed before it finished.");
    this.name = "SignInCancelledError";
  }
}

/** Reads the session already stored in this tab, if any -- never makes a
 * network call. */
export function getSession(): Session | undefined {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.token === "string" && typeof parsed.walletAddress === "string") {
      return { token: parsed.token, walletAddress: parsed.walletAddress };
    }
    return undefined;
  } catch {
    // A private window or blocked site data can make sessionStorage throw
    // or return malformed JSON -- treated the same as "no session" rather
    // than crashing the page.
    return undefined;
  }
}

function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Best-effort only; a page that cannot persist the session still works
    // for the current render, it just asks for the passkey again on reload.
  }
}

export function signOut(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage was never reachable in the first place.
  }
}

interface LoginOptionsResponse {
  loginId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

interface RegisterOptionsResponse {
  registrationId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

interface VerifyResponse {
  token: string;
  walletAddress: string;
}

/** The browser reports a dismissed, timed-out or aborted WebAuthn prompt
 * as `NotAllowedError`/`AbortError` (SimpleWebAuthn wraps both as
 * `ERROR_CEREMONY_ABORTED`, or passes a bare `NotAllowedError` through). */
function isCancelled(error: unknown): boolean {
  if (error instanceof WebAuthnError) {
    if (error.code === "ERROR_CEREMONY_ABORTED") {
      return true;
    }
    const cause = error.cause;
    return cause instanceof Error && (cause.name === "NotAllowedError" || cause.name === "AbortError");
  }
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
}

async function register(): Promise<Session> {
  const { registrationId, options } = await apiPost<RegisterOptionsResponse>("/auth/passkey/register/options", {});
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (error) {
    throw isCancelled(error) ? new SignInCancelledError() : error;
  }
  const verified = await apiPost<VerifyResponse>("/auth/passkey/register/verify", { registrationId, response });
  return { token: verified.token, walletAddress: verified.walletAddress };
}

async function login(): Promise<Session> {
  const { loginId, options } = await apiPost<LoginOptionsResponse>("/auth/passkey/login/options", {});
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (error) {
    throw isCancelled(error) ? new SignInCancelledError() : error;
  }
  const verified = await apiPost<VerifyResponse>("/auth/passkey/login/verify", { loginId, response });
  return { token: verified.token, walletAddress: verified.walletAddress };
}

/**
 * Signs the user in with a passkey. Tries a discoverable-credential login
 * first; if the backend has never seen this passkey (`404 PASSKEY_UNKNOWN`)
 * it falls straight through to registration, so a first-time user gets an
 * account from the same single tap -- there is no separate "create
 * account" screen to explain.
 *
 * Throws {@link SignInCancelledError} when the prompt was closed unfinished,
 * {@link ApiError} for a backend rejection (`401 PASSKEY_INVALID`, expired
 * challenge), and re-throws anything else (no WebAuthn support, network
 * drop) untouched.
 */
export async function signIn(): Promise<Session> {
  let session: Session;
  try {
    session = await login();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === "PASSKEY_UNKNOWN") {
      session = await register();
    } else {
      throw error;
    }
  }
  saveSession(session);
  return session;
}

interface SignResponse {
  signedXdr: string;
}

/**
 * Signs a Stellar transaction the backend already built (an escrow deploy
 * or fund XDR, a balance payment, a dispute resolution) with the account's
 * custodial key, server-side. There is no user prompt any more -- the
 * passkey sign-in is the user's consent, the JWT proves it, and the backend
 * signs on the account's behalf.
 *
 * `walletAddress` is accepted for surface compatibility with the twelve
 * existing callers but is not needed: the backend signs with whichever key
 * belongs to the session's own account, never one the caller names.
 *
 * Throws {@link ApiError} on a `401` (dead session -- callers already sign
 * out on that) or any other backend refusal.
 */
export async function signXdr(unsignedXdr: string, _walletAddress: string): Promise<string> {
  const session = getSession();
  if (!session) {
    throw new ApiError({ code: "UNAUTHORIZED", message: "Your session ended. Sign in again to continue." }, 401);
  }
  const { signedXdr } = await apiPost<SignResponse>("/me/sign", { unsignedXdr }, session.token);
  return signedXdr;
}
