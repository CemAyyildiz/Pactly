import { useState } from "react";

import { ApiError } from "../../api/client";
import { resolveDispute, submitSignedTransaction, useAdminDisputes } from "../../api/hooks";
import { formatMoney } from "../../lib/money";
import { shortenStellarId } from "../../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { getSession, signIn, signOut, signXdr, type Session } from "../../wallet";
import type { AdminDisputeListItem, DisputeOutcome } from "../../api/types";

const REASON_LABEL: Record<AdminDisputeListItem["reason"], string> = {
  "client-cancel": "The client cancelled",
  "provider-cancel": "The provider cancelled",
  "no-show": "A no-show was claimed",
  disagreement: "A plain disagreement",
};

const SUGGESTED_OUTCOME_LABEL: Record<DisputeOutcome, string> = {
  "refund-client": "Refund the client in full",
  "pay-provider": "Pay the full deposit to the provider",
};

function signInErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "You didn't sign. Nothing changed.";
}

/** One open dispute's own row: who opened it, why, the policy's own
 * suggestion (guidance only -- "The admin may pick either outcome" per the
 * spec's own Boundaries), and the two resolve buttons. */
function DisputeRow({ dispute, session, onResolved }: { dispute: AdminDisputeListItem; session: Session; onResolved: () => void }) {
  const [busy, setBusy] = useState<DisputeOutcome | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  async function resolve(outcome: DisputeOutcome): Promise<void> {
    setBusy(outcome);
    setError(undefined);
    try {
      // Building the resolve XDR is itself harmless (nothing moves until it
      // is signed) -- this page still only ever calls it on an explicit tap
      // of one of the two outcome buttons below, never automatically.
      const built = await resolveDispute(dispute.bookingId, outcome, session);
      let signedXdr: string;
      try {
        signedXdr = await signXdr(built.unsignedXdr, session.walletAddress);
      } catch {
        setError("You didn't sign. Nothing changed -- try again whenever you're ready.");
        return;
      }
      await submitSignedTransaction(dispute.bookingId, signedXdr, session);
      onResolved();
    } catch (submitError) {
      if (submitError instanceof ApiError && submitError.code === "NOT_DISPUTE_RESOLVER") {
        setError("This admin wallet is not Pactly's own dispute resolver -- only that wallet may sign a resolution.");
      } else if (submitError instanceof ApiError) {
        setError(submitError.message);
      } else {
        setError("Connection dropped. Nothing changed.");
      }
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <article className="booking-card">
      <header className="booking-card__header">
        <div>
          <p className="booking-card__heading">{dispute.provider.displayName || dispute.provider.id}</p>
          <p className="booking-card__subheading">Client {shortenStellarId(dispute.clientWalletAddress)}</p>
        </div>
      </header>
      <p className="booking-card__appointment">
        {dispute.slotStartsAt !== null ? `${formatSlotDay(dispute.slotStartsAt)} · ${formatSlotTime(dispute.slotStartsAt)}` : "No appointment time on record"}
      </p>
      <dl className="booking-card__amounts">
        <div className="booking-card__amount-row">
          <dt>Deposit</dt>
          <dd className="tabular-nums">{formatMoney(dispute.amount.amount, dispute.amount.asset)}</dd>
        </div>
        <div className="booking-card__amount-row">
          <dt>Opened by</dt>
          <dd className="tabular-nums">{shortenStellarId(dispute.openedByWallet)}</dd>
        </div>
      </dl>
      <p>
        <b>{REASON_LABEL[dispute.reason]}.</b>{" "}
        {dispute.suggestedOutcome
          ? `Policy suggestion: ${SUGGESTED_OUTCOME_LABEL[dispute.suggestedOutcome]}.`
          : "The booking policy has no automatic suggestion for a plain disagreement."}
      </p>
      <div className="booking-card__actions">
        <button type="button" className="button-primary" disabled={busy !== undefined} onClick={() => void resolve("refund-client")}>
          {busy === "refund-client" ? "Approve it in your wallet…" : "Refund the client"}
        </button>
        <button type="button" className="button-primary" disabled={busy !== undefined} onClick={() => void resolve("pay-provider")}>
          {busy === "pay-provider" ? "Approve it in your wallet…" : "Pay the provider"}
        </button>
      </div>
      {error && (
        <p className="booking-card__notice booking-card__notice--alert" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/**
 * `/admin/resolutions` -- Story 3.6's own plain admin list (Epic 3 context:
 * "Admin approval queue | Direct link | ... | MVP (plain)" is the same
 * pattern this reuses): every dispute the chain still shows as open, who
 * opened it, why, and the policy's own suggested outcome, with two buttons
 * to resolve it either way. The backend is the only place that actually
 * checks "is this wallet allowed to" (`404 NOT_ADMIN` / `403
 * NOT_DISPUTE_RESOLVER`) -- this page just signs in and shows whatever
 * comes back.
 */
export function ResolutionsPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [signInError, setSignInError] = useState<string | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);

  const disputesQuery = useAdminDisputes(session);

  async function handleSignIn(): Promise<void> {
    setSigningIn(true);
    setSignInError(undefined);
    try {
      const nextSession = await signIn();
      setSession(nextSession);
    } catch (error) {
      setSignInError(signInErrorMessage(error));
    } finally {
      setSigningIn(false);
    }
  }

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  if (!session) {
    return (
      <div className="page">
        <h1>Resolutions</h1>
        <p>Sign in with Pactly's admin wallet to see and resolve open disputes.</p>
        <button type="button" className="button-primary" onClick={handleSignIn} disabled={signingIn}>
          {signingIn ? "Approve it in your wallet…" : "Sign in with wallet"}
        </button>
        {signInError && (
          <p className="field__error" role="alert">
            {signInError}
          </p>
        )}
      </div>
    );
  }

  if (disputesQuery.isLoading) {
    return (
      <div className="page">
        <p>Loading open disputes…</p>
      </div>
    );
  }

  if (disputesQuery.error) {
    const notAdmin = disputesQuery.error instanceof ApiError && disputesQuery.error.code === "NOT_ADMIN";
    return (
      <div className="page">
        <div className="banner" role="status">
          <p>{notAdmin ? "This wallet is not a Pactly admin." : "Connection dropped. Try again."}</p>
        </div>
        <button type="button" className="button-ghost" onClick={handleSignOut} style={{ marginTop: "var(--space-4)" }}>
          Sign out
        </button>
      </div>
    );
  }

  const disputes = disputesQuery.data?.disputes ?? [];

  return (
    <div className="page">
      <div className="top-bar" style={{ padding: 0, border: "none", marginBottom: "var(--space-6)" }}>
        <h1 style={{ margin: 0 }}>Resolutions</h1>
        <div className="top-bar__nav">
          <button type="button" className="button-ghost" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </div>

      {disputes.length === 0 && (
        <div className="banner" role="status">
          <p>No open disputes.</p>
        </div>
      )}

      {disputes.length > 0 && (
        <div className="booking-list">
          {disputes.map((dispute) => (
            <DisputeRow key={dispute.bookingId} dispute={dispute} session={session} onResolved={() => void disputesQuery.refetch()} />
          ))}
        </div>
      )}
    </div>
  );
}
