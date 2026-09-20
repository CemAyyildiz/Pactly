import { useState } from "react";
import { Link } from "react-router";
import { CalendarCheckIcon } from "@phosphor-icons/react";

import { useMyBookings } from "../../api/hooks";
import { BookingCard } from "../../components/BookingCard";
import { PageMasthead } from "../../components/PageMasthead";
import { SignInPanel } from "../../components/SignInPanel";
import { getSession, signOut, type Session } from "../../wallet";

/**
 * `/me/bookings` -- "My bookings" (Task list): every booking the signed-in
 * account is the client on, across every provider, as mobile-first cards.
 * Sign-in only happens here, when the client actually wants to see their
 * bookings -- never before (Epic 3 context: sign-in is requested only at
 * payment, and now also at this read).
 */
export function MyBookingsPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());

  const bookingsQuery = useMyBookings(session);

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  if (!session) {
    return (
      <div className="page">
        <PageMasthead
          eyebrow="Your side of the escrow"
          icon={<CalendarCheckIcon size={14} weight="bold" aria-hidden="true" />}
          title="My bookings"
          lede="Sign in to see the sessions you've locked a deposit for."
        />
        <SignInPanel onSignedIn={setSession} />
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
      <PageMasthead
        eyebrow="Your side of the escrow"
        icon={<CalendarCheckIcon size={14} weight="bold" aria-hidden="true" />}
        title="My bookings"
        actions={
          <button type="button" className="button-ghost" onClick={handleSignOut}>
            Sign out
          </button>
        }
      />

      {active.length === 0 && (
        <div className="banner" role="status">
          <p>No bookings yet.</p>
          <Link to="/discover" className="button-primary" style={{ textDecoration: "none", display: "inline-flex", marginTop: "var(--space-3)" }}>
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
              continueHref={
                booking.escrowState === null && booking.slotStartsAt !== null
                  ? `/book/${booking.provider.id}?slot=${booking.slotStartsAt}`
                  : undefined
              }
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
