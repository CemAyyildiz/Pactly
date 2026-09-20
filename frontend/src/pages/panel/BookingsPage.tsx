import { useState } from "react";
import { Link } from "react-router";
import { StorefrontIcon } from "@phosphor-icons/react";

import { ApiError } from "../../api/client";
import { useProviderBookings } from "../../api/hooks";
import { BookingActions } from "../../components/BookingActions";
import { BookingCard, BALANCE_STATE_LABEL } from "../../components/BookingCard";
import { Countdown } from "../../components/Countdown";
import { PageMasthead } from "../../components/PageMasthead";
import { StateLabel } from "../../components/StateLabel";
import { TryAmount } from "../../components/TryAmount";
import { shortenStellarId, stellarExplorerContractUrl, stellarExplorerTransactionUrl, trustlessWorkViewerUrl } from "../../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { SignInPanel } from "../../components/SignInPanel";
import { getSession, signOut, type Session } from "../../wallet";

/**
 * `/panel/bookings` -- the provider panel's own "Bookings" view (Task
 * list): every booking against the caller's own provider profile, a table
 * at >=1024px and cards below (DESIGN.md: "Provider panel: desktop-first,
 * table layout. On mobile the table becomes a card list."). Both markups
 * render the same data; only CSS decides which one shows at a given width,
 * so there is exactly one source of truth for the list itself.
 */
export function BookingsPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());

  const bookingsQuery = useProviderBookings(session);

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  if (!session) {
    return (
      <div className="page">
        <PageMasthead
          eyebrow="Provider panel"
          icon={<StorefrontIcon size={14} weight="bold" aria-hidden="true" />}
          title="Bookings"
          lede="Sign in to see your incoming bookings."
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
    const notAProvider = bookingsQuery.error instanceof ApiError && bookingsQuery.error.code === "NOT_A_PROVIDER";
    return (
      <div className="page">
        <div className="banner" role="status">
          <p>{notAProvider ? "This account doesn't have a provider profile yet." : "Connection dropped. Try again."}</p>
          {notAProvider && (
            <Link to="/providers/apply" className="button-primary" style={{ textDecoration: "none", marginTop: "var(--space-3)" }}>
              List your shop
            </Link>
          )}
        </div>
        <button type="button" className="button-ghost" onClick={handleSignOut} style={{ marginTop: "var(--space-4)" }}>
          Sign out
        </button>
      </div>
    );
  }

  const bookings = bookingsQuery.data?.bookings ?? [];
  const active = bookings.filter((booking) => !booking.isExpiredHold);
  const expired = bookings.filter((booking) => booking.isExpiredHold);

  return (
    <div className="page">
      <PageMasthead
        eyebrow="Provider panel"
        icon={<StorefrontIcon size={14} weight="bold" aria-hidden="true" />}
        title="Bookings"
        actions={
          <>
            <Link to="/panel/availability">Availability &amp; rules</Link>
            <button type="button" className="button-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        }
      />

      {active.length === 0 && (
        <div className="banner" role="status">
          <p>No bookings yet.</p>
        </div>
      )}

      {active.length > 0 && (
        <>
          <div className="bookings-table-wrap">
            <table className="bookings-table">
              <thead>
                <tr>
                  <th>Appointment</th>
                  <th>Client id</th>
                  <th>Deposit</th>
                  <th>Balance</th>
                  <th>State</th>
                  <th>Free cancellation</th>
                  <th>Records</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {active.map((booking) => (
                  <tr key={booking.id}>
                    <td>
                      {booking.slotStartsAt !== null
                        ? `${formatSlotDay(booking.slotStartsAt)} · ${formatSlotTime(booking.slotStartsAt)}`
                        : "—"}
                    </td>
                    <td className="tabular-nums">{shortenStellarId(booking.clientWalletAddress)}</td>
                    <td className="tabular-nums">
                      <TryAmount amount={booking.deposit.amount} />
                    </td>
                    <td className="tabular-nums">
                      <TryAmount amount={booking.balance.amount} /> · {BALANCE_STATE_LABEL[booking.balanceState]}
                      {/* Review follow-up: lives in this cell, not
                       * `BookingActions`'s own Actions column, which renders
                       * nothing once the booking leaves `locked` -- exactly
                       * the state a settled booking's own link must keep
                       * showing in. */}
                      {booking.balanceState === "paid_platform" && booking.balancePaymentTxHash && (
                        <>
                          {" · "}
                          <a href={stellarExplorerTransactionUrl(booking.balancePaymentTxHash)} target="_blank" rel="noreferrer">
                            View payment record
                          </a>
                        </>
                      )}
                    </td>
                    <td>
                      <StateLabel lifecycle={booking.lifecycle} viewer="provider" />
                    </td>
                    <td>
                      <Countdown cancelDeadline={booking.cancelDeadline} />
                    </td>
                    <td>
                      {booking.contractId && (
                        <>
                          <a href={stellarExplorerContractUrl(booking.contractId)} target="_blank" rel="noreferrer">
                            View escrow record
                          </a>
                          {" · "}
                          <a href={trustlessWorkViewerUrl(booking.contractId)} target="_blank" rel="noreferrer">
                            Escrow Viewer
                          </a>
                        </>
                      )}
                    </td>
                    <td>
                      <BookingActions
                        viewer="provider"
                        id={booking.id}
                        escrowState={booking.escrowState}
                        lifecycle={booking.lifecycle}
                        pendingAction={booking.pendingAction}
                        deposit={booking.deposit}
                        balance={booking.balance}
                        balanceState={booking.balanceState}
                        slotStartsAt={booking.slotStartsAt}
                        session={session}
                        onActionSubmitted={() => bookingsQuery.refetch()}
                        onUnauthorized={handleSignOut}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="booking-list bookings-cards">
            {active.map((booking) => (
              <BookingCard
                key={booking.id}
                viewer="provider"
                id={booking.id}
                heading="Client id"
                subheading={shortenStellarId(booking.clientWalletAddress)}
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
        </>
      )}

      {expired.length > 0 && (
        <details className="expired-holds">
          <summary>Expired holds ({expired.length})</summary>
          <div className="booking-list">
            {expired.map((booking) => (
              <BookingCard
                key={booking.id}
                viewer="provider"
                id={booking.id}
                heading="Client id"
                subheading={shortenStellarId(booking.clientWalletAddress)}
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
