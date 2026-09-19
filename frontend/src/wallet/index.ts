/**
 * Stellar Wallets Kit wrapper: connect, sign Pactly's own `/auth/challenge`
 * XDR, exchange it at `/auth/verify` for a Pactly JWT, keep the session in
 * `sessionStorage` (cleared on tab close -- never `localStorage`, so a
 * shared machine never carries a session forward), and sign out.
 *
 * The wallet is asked for exactly once per sign-in, at this single call
 * (`signIn`) -- the panel's own equivalent of the client flow's "the wallet
 * is requested only at payment" rule (Epic 3 context).
 */
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";

import { apiPost } from "../api/client";

const SESSION_STORAGE_KEY = "pactly.session";

export interface Session {
  token: string;
  walletAddress: string;
}

let kitInitialized = false;

function ensureKitInitialized(): void {
  if (kitInitialized) {
    return;
  }
  StellarWalletsKit.init({ modules: defaultModules(), network: Networks.TESTNET });
  kitInitialized = true;
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
    // for the current render, it just asks the wallet to sign in again on
    // reload.
  }
}

export function signOut(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage was never reachable in the first place.
  }
}

interface ChallengeResponse {
  transaction: string;
}

interface VerifyResponse {
  token: string;
  walletAddress: string;
}

/**
 * Opens the kit's own wallet picker, signs Pactly's SEP-10-shaped
 * challenge with the chosen wallet, and exchanges it for a Pactly JWT.
 * Throws {@link ApiError} for a backend-side rejection (expired/replayed
 * challenge) and re-throws whatever the kit itself throws for a
 * rejected-in-the-wallet signature -- callers show that as neutral
 * information, never a warning (EXPERIENCE.md: "Wallet rejected").
 */
export async function signIn(): Promise<Session> {
  ensureKitInitialized();
  const { address } = await StellarWalletsKit.authModal();

  const { transaction } = await apiPost<ChallengeResponse>("/auth/challenge", { publicKey: address });

  const { signedTxXdr } = await StellarWalletsKit.signTransaction(transaction, {
    address,
    networkPassphrase: Networks.TESTNET,
  });

  const verified = await apiPost<VerifyResponse>("/auth/verify", { transaction: signedTxXdr });
  const session: Session = { token: verified.token, walletAddress: verified.walletAddress };
  saveSession(session);
  return session;
}

/**
 * Story 3.4: signs an escrow transaction (a deploy or a fund XDR) the
 * backend already built -- distinct from `signIn`'s own challenge
 * signature. Reuses whichever wallet module `signIn`'s own `authModal()`
 * call already selected (the kit remembers it), so this never re-opens the
 * wallet picker -- only the initial sign-in ever does that, per the "wallet
 * requested only at payment" rule this call is itself part of.
 *
 * Re-throws whatever the kit throws for a declined signature; the caller
 * (`BookingPage.tsx`) shows that as neutral information, never a warning
 * (EXPERIENCE.md: "You didn't sign. The slot is still yours for N
 * minutes.").
 */
export async function signXdr(unsignedXdr: string, walletAddress: string): Promise<string> {
  ensureKitInitialized();
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(unsignedXdr, {
    address: walletAddress,
    networkPassphrase: Networks.TESTNET,
  });
  return signedTxXdr;
}
