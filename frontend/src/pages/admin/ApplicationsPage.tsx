import { useEffect, useState } from "react";
import { Link } from "react-router";
import { StorefrontIcon } from "@phosphor-icons/react";

import { ApiError } from "../../api/client";
import { decideProviderApplication, useAdminApplications } from "../../api/hooks";
import type { AdminProviderApplication } from "../../api/types";
import { PageMasthead } from "../../components/PageMasthead";
import { formatMoney } from "../../lib/money";
import { formatSessionFormat } from "../../lib/sessionFormat";
import { shortenStellarId } from "../../lib/stellar";
import { SignInPanel } from "../../components/SignInPanel";
import { getSession, signOut, type Session } from "../../wallet";

function ApplicationRow({
  application,
  session,
  onDecided,
  onUnauthorized,
}: {
  application: AdminProviderApplication;
  session: Session;
  onDecided: () => void;
  onUnauthorized: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  async function decide(outcome: "approve" | "reject"): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await decideProviderApplication(application.id, outcome, session, outcome === "reject" ? reason : undefined);
      onDecided();
    } catch (decideError) {
      if (decideError instanceof ApiError && decideError.status === 401) {
        onUnauthorized();
        return;
      }
      if (decideError instanceof ApiError) {
        const detail = (decideError.details as Record<string, string> | undefined)?.reason;
        setError(detail ?? decideError.message);
      } else {
        setError("Connection dropped. Nothing changed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="booking-card">
      <header className="booking-card__header">
        <div>
          <p className="booking-card__heading">{application.name}</p>
          <p className="booking-card__subheading">
            {application.title} · {application.category.name} · {shortenStellarId(application.walletAddress)}
          </p>
        </div>
      </header>
      <p>{application.serviceDescription}</p>
      <dl className="booking-card__amounts">
        <div className="booking-card__amount-row">
          <dt>Session</dt>
          <dd>
            {formatSessionFormat(application.sessionFormat)} · {application.sessionLengthMinutes} min
          </dd>
        </div>
        <div className="booking-card__amount-row">
          <dt>Price</dt>
          <dd className="tabular-nums">{formatMoney(application.price.amount, application.price.asset)}</dd>
        </div>
        <div className="booking-card__amount-row">
          <dt>Deposit</dt>
          <dd className="tabular-nums">
            {formatMoney(application.deposit.amount, application.deposit.asset)} · full refund up to {application.cancellationWindowHours}h before
          </dd>
        </div>
      </dl>

      {rejecting ? (
        <div className="field" style={{ marginTop: "var(--space-3)" }}>
          <label htmlFor={`reject-${application.id}`}>Reason the applicant will read</label>
          <textarea id={`reject-${application.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="booking-card__actions">
            <button type="button" className="button-primary" disabled={busy || reason.trim().length === 0} onClick={() => void decide("reject")}>
              {busy ? "Sending…" : "Send rejection"}
            </button>
            <button type="button" className="button-ghost" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="booking-card__actions">
          <button type="button" className="button-primary" disabled={busy} onClick={() => void decide("approve")}>
            {busy ? "Approving…" : "Approve and list"}
          </button>
          <button type="button" className="button-ghost" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
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
 * `/admin/applications` -- Story 4.2's approval queue. Same sign-in and
 * 401 discipline as `ResolutionsPage`; the backend alone decides who is
 * an admin (`404 NOT_ADMIN`).
 */
export function ApplicationsPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [sessionExpired, setSessionExpired] = useState(false);

  const applicationsQuery = useAdminApplications(session);

  function handleSignedIn(nextSession: Session): void {
    setSession(nextSession);
    setSessionExpired(false);
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

  const unauthorized = applicationsQuery.error instanceof ApiError && applicationsQuery.error.status === 401;
  useEffect(() => {
    if (unauthorized) {
      handleUnauthorized();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unauthorized]);

  const masthead = (
    <PageMasthead
      eyebrow="Pactly admin"
      icon={<StorefrontIcon size={14} weight="bold" aria-hidden="true" />}
      title="Applications"
      lede={session ? undefined : "Sign in with a Pactly admin passkey to review shops waiting to be listed."}
      actions={
        session ? (
          <>
            <Link to="/admin/resolutions">Resolutions</Link>
            <button type="button" className="button-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        ) : undefined
      }
    />
  );

  if (!session) {
    return (
      <div className="page">
        {masthead}
        {sessionExpired && (
          <div className="banner banner--alert" role="alert">
            <p>Your session ended. Sign in again to continue.</p>
          </div>
        )}
        <SignInPanel onSignedIn={handleSignedIn} />
      </div>
    );
  }

  if (applicationsQuery.isLoading) {
    return (
      <div className="page">
        {masthead}
        <p>Loading applications…</p>
      </div>
    );
  }

  if (applicationsQuery.error) {
    if (unauthorized) {
      return null;
    }
    const notAdmin = applicationsQuery.error instanceof ApiError && applicationsQuery.error.code === "NOT_ADMIN";
    return (
      <div className="page">
        {masthead}
        <div className="banner" role="status">
          <p>{notAdmin ? "This account is not a Pactly admin." : "Connection dropped. Try again."}</p>
        </div>
      </div>
    );
  }

  const applications = applicationsQuery.data?.applications ?? [];

  return (
    <div className="page">
      {masthead}
      {applications.length === 0 && (
        <div className="banner" role="status">
          <p>No applications waiting.</p>
        </div>
      )}
      {applications.length > 0 && (
        <div className="booking-list">
          {applications.map((application) => (
            <ApplicationRow
              key={application.id}
              application={application}
              session={session}
              onDecided={() => void applicationsQuery.refetch()}
              onUnauthorized={handleUnauthorized}
            />
          ))}
        </div>
      )}
    </div>
  );
}
