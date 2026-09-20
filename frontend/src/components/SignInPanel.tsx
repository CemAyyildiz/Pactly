import { useState, type ReactNode } from "react";
import { FingerprintSimpleIcon } from "@phosphor-icons/react";

import { ApiError } from "../api/client";
import { SignInCancelledError, signIn, type Session } from "../wallet";

export interface SignInPanelProps {
  onSignedIn: (session: Session) => void;
  /** Replaces the default one-line explanation of what a passkey is --
   * for a page that has already said it in its own words (e.g. the "List
   * your shop" steps). */
  intro?: ReactNode;
}

/**
 * The one signed-out state, shared by every screen that needs a session
 * (My bookings, the provider panel, the admin queues, "List your shop",
 * and the booking page's own hold button copy mirrors it). A single tap
 * runs the passkey prompt; a passkey the backend has never seen becomes an
 * account on the spot (`wallet/index.ts`'s `signIn`), so this card never
 * has to ask "new here?".
 *
 * A closed prompt is neutral information, never a warning; a backend
 * rejection shows the backend's own message; anything else is a
 * connection drop.
 */
export function SignInPanel({ onSignedIn, intro }: SignInPanelProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSignIn(): Promise<void> {
    setPending(true);
    setError(undefined);
    try {
      onSignedIn(await signIn());
    } catch (caught) {
      setError(signInErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card sign-in-panel">
      <p className="sign-in-panel__intro">
        {intro ?? "Sign in with your passkey — your face, fingerprint or device PIN. No password, no app to install."}
      </p>
      <button type="button" className="button-primary" onClick={() => void handleSignIn()} disabled={pending} aria-live="polite">
        <FingerprintSimpleIcon size={18} weight="bold" aria-hidden="true" />
        {pending ? "Check your device…" : "Continue with passkey"}
      </button>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The sign-in error line, exported for screens that run `signIn()`
 * themselves (the booking page's own hold button). */
export function signInErrorMessage(error: unknown): string {
  if (error instanceof SignInCancelledError) {
    return "You didn't finish signing in. Nothing changed.";
  }
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.name === "NotSupportedError") {
    return "This browser can't use passkeys. Try a current version of Safari, Chrome or Edge.";
  }
  return "Connection dropped. Nothing changed.";
}
