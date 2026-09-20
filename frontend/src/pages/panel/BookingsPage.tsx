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
import { formatMoney } from "../../lib/money";
import { shortenStellarId, stellarExplorerContractUrl, stellarExplorerTransactionUrl, trustlessWorkViewerUrl } from "../../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { getSession, signIn, signOut, type Session } from "../../wallet";

function signInErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "You didn't sign. Nothing changed.";
}

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
  const [signInError, setSignInError] = useState<string | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);

  const bookingsQuery = useProviderBookings(session);

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
        <PageMasthead
          eyebrow="Provider panel"
          icon={<StorefrontIcon size={14} weight="bold" aria-hidden="true" />}
          title="Bookings"
          lede="Sign in with your wallet to see your incoming bookings."
        />
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
    const notAProvider = bookingsQuery.error instanceof ApiError && bookingsQuery.error.code === "NOT_A_PROVIDER";
    return (
      <div className="page">
        <div className="banner" role="status">
          <p>
            {notAProvider
              ? "This wallet doesn't have a provider profile yet. Becoming a provider is a separate step, coming in a later update."
              : "Connection dropped. Try again."}
          </p>
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
                  <th>Client</th>
                  <th>Deposit</th>
                  <th>Balance</th>
                  <th>State</th>
                  <th>Free cancellation</th>
                  <th>Explorer</th>
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
                    <td className="tabular-nums">{formatMoney(booking.deposit.amount, booking.deposit.asset)}</td>
                    <td className="tabular-nums">
                      {formatMoney(booking.balance.amount, booking.balance.asset)} · {BALANCE_STATE_LABEL[booking.balanceState]}
                      {/* Review follow-up: lives in this cell, not
                       * `BookingActions`'s own Actions column, which renders
                       * nothing once the booking leaves `locked` -- exactly
                       * the state a settled booking's own link must keep
                       * showing in. */}
                      {booking.balanceState === "paid_platform" && booking.balancePaymentTxHash && (
                        <>
                          {" · "}
                          <a href={stellarExplorerTransactionUrl(booking.balancePaymentTxHash)} target="_blank" rel="noreferrer">
                            View on Stellar Expert
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
                            View on Stellar Expert
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
                heading="Client"
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
                heading="Client"
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
