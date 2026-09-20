import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ScalesIcon } from "@phosphor-icons/react";

import { ApiError } from "../../api/client";
import { resolveDispute, submitSignedTransaction, useAdminDisputes } from "../../api/hooks";
import { PageMasthead } from "../../components/PageMasthead";
import { TryAmount } from "../../components/TryAmount";
import { shortenStellarId } from "../../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { getSession, signIn, signOut, signXdr, type Session } from "../../wallet";
import type { AdminDisputeListItem, DisputeOutcome } from "../../api/types";

const REASON_LABEL: Record<AdminDisputeListItem["reason"], string> = {
  "client-cancel": "The client cancelled",
  "provider-cancel": "The provider cancelled",
  "client-no-show": "The client didn't show up (provider's claim)",
  "provider-no-show": "The provider didn't show up (client's claim)",
  disagreement: "A plain disagreement",
  unknown: "Reason not on record",
};

const OPENER_ROLE_LABEL: Record<"client" | "provider", string> = {
  client: "Opened by the client",
  provider: "Opened by the provider",
};

const SUGGESTED_OUTCOME_LABEL: Record<DisputeOutcome, string> = {
  "refund-client": "Refund the client in full",
  "pay-provider": "Pay the full deposit to the provider",
};

function signInErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "You didn't sign. Nothing changed.";
}

/** One open dispute's own row: who opened it (and which role), why, the
 * policy's own suggestion (guidance only -- "The admin may pick either
 * outcome" per the spec's own Boundaries), and the two resolve buttons.
 * Hides its own actions once `pendingAction === "resolve"` -- a resolve for
 * this exact dispute is already awaiting chain confirmation, so a second
 * one would only ever be refused (`409 ACTION_PENDING`). */
function DisputeRow({
  dispute,
  session,
  onResolved,
  onUnauthorized,
}: {
  dispute: AdminDisputeListItem;
  session: Session;
  onResolved: () => void;
  onUnauthorized: () => void;
}) {
  const [busy, setBusy] = useState<DisputeOutcome | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const resolvePending = dispute.pendingAction === "resolve";

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
      if (submitError instanceof ApiError && submitError.status === 401) {
        onUnauthorized();
        return;
      }
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
          <dd className="tabular-nums">
            <TryAmount amount={dispute.amount.amount} />
          </dd>
        </div>
        <div className="booking-card__amount-row">
          <dt>{dispute.openedByRole ? OPENER_ROLE_LABEL[dispute.openedByRole] : "Opened by"}</dt>
          <dd className="tabular-nums">{dispute.openedByWallet ? shortenStellarId(dispute.openedByWallet) : "unknown"}</dd>
        </div>
      </dl>
      <p>
        <b>{REASON_LABEL[dispute.reason]}.</b>{" "}
        {dispute.suggestedOutcome
          ? `Policy suggestion: ${SUGGESTED_OUTCOME_LABEL[dispute.suggestedOutcome]}.`
          : "The booking policy has no automatic suggestion for a plain disagreement."}
      </p>
      {resolvePending ? (
        <p className="booking-card__notice" aria-live="polite">
          Waiting for the network to confirm.
        </p>
      ) : (
        <div className="booking-card__actions">
          <button type="button" className="button-primary" disabled={busy !== undefined} onClick={() => void resolve("refund-client")}>
            {busy === "refund-client" ? "Approve it in your wallet…" : "Refund the client"}
          </button>
          <button type="button" className="button-primary" disabled={busy !== undefined} onClick={() => void resolve("pay-provider")}>
            {busy === "pay-provider" ? "Approve it in your wallet…" : "Pay the provider"}
          </button>
        </div>
      )}
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
 * opened it (and which role), why, and the policy's own suggested outcome,
 * with two buttons to resolve it either way. The backend is the only place
 * that actually checks "is this wallet allowed to" (`404 NOT_ADMIN` / `403
 * NOT_DISPUTE_RESOLVER`) -- this page just signs in and shows whatever comes
 * back, and signs the wallet out again the moment a call comes back `401`
 * (an expired or tampered session), prompting it to sign in again rather
 * than sitting on a dead token.
 */
export function ResolutionsPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [signInError, setSignInError] = useState<string | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const disputesQuery = useAdminDisputes(session);

  async function handleSignIn(): Promise<void> {
    setSigningIn(true);
    setSignInError(undefined);
    try {
      const nextSession = await signIn();
      setSession(nextSession);
      setSessionExpired(false);
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

  function handleUnauthorized(): void {
    signOut();
    setSession(undefined);
    setSessionExpired(true);
  }

  if (!session) {
    return (
      <div className="page">
        <PageMasthead
          eyebrow="Pactly admin"
          icon={<ScalesIcon size={14} weight="bold" aria-hidden="true" />}
          title="Resolutions"
          lede="Sign in with Pactly's admin wallet to see and resolve open disputes."
        />
        {sessionExpired && (
          <div className="banner banner--alert" role="alert">
            <p>Your session ended. Sign in again to continue.</p>
          </div>
        )}
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

  const unauthorized = disputesQuery.error instanceof ApiError && disputesQuery.error.status === 401;
  useEffect(() => {
    if (unauthorized) {
      handleUnauthorized();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unauthorized]);

  if (disputesQuery.isLoading) {
    return (
      <div className="page">
        <p>Loading open disputes…</p>
      </div>
    );
  }

  if (disputesQuery.error) {
    if (unauthorized) {
      // The effect above already signs this wallet out and shows the
      // sign-in screen with "Your session ended" on the next render.
      return null;
    }
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
      <PageMasthead
        eyebrow="Pactly admin"
        icon={<ScalesIcon size={14} weight="bold" aria-hidden="true" />}
        title="Resolutions"
        actions={
          <>
            <Link to="/admin/applications">Applications</Link>
            <button type="button" className="button-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        }
      />

      {disputes.length === 0 && (
        <div className="banner" role="status">
          <p>No open disputes.</p>
        </div>
      )}

      {disputes.length > 0 && (
        <div className="booking-list">
          {disputes.map((dispute) => (
            <DisputeRow
              key={dispute.bookingId}
              dispute={dispute}
              session={session}
              onResolved={() => void disputesQuery.refetch()}
              onUnauthorized={handleUnauthorized}
            />
          ))}
        </div>
      )}
    </div>
  );
}
