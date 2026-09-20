import { useState } from "react";
import { Link } from "react-router";

import { ApiError } from "../../api/client";
import { useMyBookings } from "../../api/hooks";
import { BookingCard } from "../../components/BookingCard";
import { getSession, signIn, signOut, type Session } from "../../wallet";

/** A sign-in failure that carries no field-level detail -- a declined
 * wallet signature, or a network drop mid-exchange (same shape as
 * `AvailabilityPage.tsx`'s own `saveErrorMessage`, this screen's own
 * equivalent case). */
function signInErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "You didn't sign. Nothing changed.";
}

/**
 * `/me/bookings` -- "My bookings" (Task list): every booking the signed-in
 * wallet is the client on, across every provider, as mobile-first cards.
 * Wallet sign-in only happens here, when the client actually wants to see
 * their bookings -- never before (Epic 3 context: "the wallet is requested
 * only at payment", and now also at this read).
 */
export function MyBookingsPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [signInError, setSignInError] = useState<string | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);

  const bookingsQuery = useMyBookings(session);

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
        <h1>My bookings</h1>
        <p>Sign in with your wallet to see the sessions you've locked a deposit for.</p>
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

  if (bookingsQuery.isLoading) {
    return (
      <div className="page">
        <p>Loading your bookings…</p>
      </div>
    );
  }

  if (bookingsQuery.error) {
    return (
      <div className="page">
        <div className="banner banner--alert" role="alert">
          <p>Connection dropped. Try again.</p>
        </div>
        <button type="button" className="button-ghost" onClick={handleSignOut} style={{ marginTop: "var(--space-4)" }}>
          Sign out
        </button>
      </div>
    );
  }

  const bookings = bookingsQuery.data?.bookings ?? [];
  // "An expired, never-funded hold is listed under 'Expired holds'
  // (collapsed), never as a booking" -- the spec's own "Always" rule.
  const active = bookings.filter((booking) => !booking.isExpiredHold);
  const expired = bookings.filter((booking) => booking.isExpiredHold);

  return (
    <div className="page">
      <div className="page-header">
        <h1 style={{ margin: 0 }}>My bookings</h1>
        <div className="page-header__nav">
          <button type="button" className="button-ghost" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </div>

      {active.length === 0 && (
        <div className="banner" role="status">
          <p>No bookings yet.</p>
          <Link to="/" className="button-primary" style={{ textDecoration: "none", display: "inline-flex", marginTop: "var(--space-3)" }}>
            Find a provider
          </Link>
        </div>
      )}

      {active.length > 0 && (
        <div className="booking-list">
          {active.map((booking) => (
            <BookingCard
              key={booking.id}
              viewer="client"
              id={booking.id}
              heading={booking.provider.displayName}
              subheading={booking.provider.title}
              slotStartsAt={booking.slotStartsAt}
              deposit={booking.deposit}
              balance={booking.balance}
              escrowState={booking.escrowState}
              lifecycle={booking.lifecycle}
              pendingAction={booking.pendingAction}
              balanceState={booking.balanceState}
              cancelDeadline={booking.cancelDeadline}
              contractId={booking.contractId}
              balancePaymentTxHash={booking.balancePaymentTxHash}
              session={session}
              onActionSubmitted={() => bookingsQuery.refetch()}
              onUnauthorized={handleSignOut}
            />
          ))}
        </div>
      )}

      {expired.length > 0 && (
        <details className="expired-holds">
          <summary>Expired holds ({expired.length})</summary>
          <div className="booking-list">
            {expired.map((booking) => (
              <BookingCard
                key={booking.id}
                viewer="client"
                id={booking.id}
                heading={booking.provider.displayName}
                subheading={booking.provider.title}
                slotStartsAt={booking.slotStartsAt}
                deposit={booking.deposit}
                balance={booking.balance}
                escrowState={booking.escrowState}
                lifecycle={booking.lifecycle}
                pendingAction={booking.pendingAction}
                balanceState={booking.balanceState}
                cancelDeadline={booking.cancelDeadline}
                contractId={booking.contractId}
                balancePaymentTxHash={booking.balancePaymentTxHash}
                session={session}
                onActionSubmitted={() => bookingsQuery.refetch()}
                onUnauthorized={handleSignOut}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
