import { Link } from "react-router";

import { BookingActions } from "./BookingActions";
import { Countdown } from "./Countdown";
import { StateLabel } from "./StateLabel";
import { formatMoney } from "../lib/money";
import { stellarExplorerContractUrl, stellarExplorerTransactionUrl, trustlessWorkViewerUrl } from "../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../lib/time";
import type { Session } from "../wallet";
import type { BalanceState, BookingLifecycle, Money, PendingActionKind } from "../api/types";

export interface BookingCardProps {
  /** Which side is looking at this card -- picks the "Resolved" wording
   * (`StateLabel`), which actions this viewer may take, and nothing else;
   * the shape is otherwise identical for both. */
  viewer: "client" | "provider";
  /** Provider display name (My bookings) or a short "who booked" label
   * (the panel's Bookings view). */
  heading: string;
  /** Provider title (My bookings) or the shortened client wallet (the
   * panel's Bookings view). */
  subheading?: string;
  id: string;
  /** UTC epoch seconds -- `null` only for a pre-3.4 booking with no slot. */
  slotStartsAt: number | null;
  deposit: Money;
  balance: Money;
  escrowState: "locked" | "released" | "refunded" | null;
  lifecycle: BookingLifecycle;
  /** Story 3.6 (review round): passed straight through to
   * {@link BookingActions} -- see its own doc comment. */
  pendingAction?: PendingActionKind;
  balanceState: BalanceState;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  /** The explorer link (AC4) appears only when this exists. */
  contractId: string | null;
  /** Story 3.7: the on-chain transaction hash once the balance was paid
   * through Pactly -- drives the balance row's own Stellar Expert link. */
  balancePaymentTxHash: string | null;
  /** Story 3.6: the signed-in wallet's own session, passed through to
   * {@link BookingActions} -- both pages that render this card already
   * require sign-in to show anything, so this is always present whenever an
   * action could apply. `undefined` simply hides every action. */
  session?: Session;
  /** Called once an action's signed transaction has actually been relayed
   * -- the caller's own cue to refetch its list (the reconciler still needs
   * to confirm it on chain before the state label itself changes). */
  onActionSubmitted?: () => void;
  /** A 401 from any action -- the caller's own sign-out-and-prompt-again
   * flow (mirrors 3.4's `handleUnauthorized`). */
  onUnauthorized?: () => void;
  /** Held, not yet locked: resume the booking screen for this slot. */
  continueHref?: string;
}

/** The balance row's own three-state wording (Epic 3 context: "Balance
 * 1,400.00 TRY · due before the session", three states) -- exported so
 * `BookingsPage.tsx`'s desktop table can render the identical wording in a
 * `<td>` instead of a card, without a second copy of this map. */
export const BALANCE_STATE_LABEL: Record<BalanceState, string> = {
  unpaid: "due before the session",
  paid_platform: "paid through Pactly",
  paid_cash: "paid in person",
};

/**
 * One booking's card (mobile-first "My bookings", and the panel's
 * `Bookings` view below 1024px). The deposit state (`StateLabel`, driven by
 * `lifecycle`) and the balance state are always two separate lines --
 * AD-3's "never merged" rule, enforced here by simply never combining them
 * into one sentence. Story 3.6's role-correct action buttons live in
 * {@link BookingActions}, shared with `BookingsPage.tsx`'s desktop table so
 * the sign-and-submit flow for every action exists in exactly one place.
 */
export function BookingCard({
  viewer,
  heading,
  subheading,
  id,
  slotStartsAt,
  deposit,
  balance,
  escrowState,
  lifecycle,
  pendingAction,
  balanceState,
  cancelDeadline,
  contractId,
  balancePaymentTxHash,
  session,
  onActionSubmitted,
  onUnauthorized,
  continueHref,
}: BookingCardProps) {
  return (
    <article className="booking-card">
      <header className="booking-card__header">
        <div>
          <p className="booking-card__heading">{heading}</p>
          {subheading && <p className="booking-card__subheading">{subheading}</p>}
        </div>
        <StateLabel lifecycle={lifecycle} viewer={viewer} />
      </header>

      <p className="booking-card__appointment">
        {slotStartsAt !== null ? `${formatSlotDay(slotStartsAt)} · ${formatSlotTime(slotStartsAt)}` : "No appointment time on record"}
      </p>

      <dl className="booking-card__amounts">
        <div className="booking-card__amount-row">
          <dt>Deposit</dt>
          <dd className="tabular-nums">{formatMoney(deposit.amount, deposit.asset)}</dd>
        </div>
        <div className="booking-card__amount-row">
          <dt>Balance</dt>
          <dd className="tabular-nums">
            {formatMoney(balance.amount, balance.asset)} · {BALANCE_STATE_LABEL[balanceState]}
          </dd>
        </div>
      </dl>

      {/* Review follow-up: lives here, not in `BookingActions`, which
       * renders nothing once the booking leaves `locked` -- exactly the
       * state a settled (`released`/`refunded`) booking's own balance
       * payment needs this link to keep showing in. */}
      {balanceState === "paid_platform" && balancePaymentTxHash && (
        <a className="booking-card__explorer-link" href={stellarExplorerTransactionUrl(balancePaymentTxHash)} target="_blank" rel="noreferrer">
          View balance payment on Stellar Expert
        </a>
      )}

      <Countdown cancelDeadline={cancelDeadline} />

      {continueHref && (
        <Link to={continueHref} className="button-primary" style={{ textDecoration: "none", display: "inline-flex", marginTop: "var(--space-3)" }}>
          Continue booking
        </Link>
      )}

      {contractId && (
        <a className="booking-card__explorer-link" href={stellarExplorerContractUrl(contractId)} target="_blank" rel="noreferrer">
          View on Stellar Expert
        </a>
      )}

      {contractId && (
        <a className="booking-card__explorer-link" href={trustlessWorkViewerUrl(contractId)} target="_blank" rel="noreferrer">
          View in Escrow Viewer
        </a>
      )}

      <BookingActions
        viewer={viewer}
        id={id}
        escrowState={escrowState}
        lifecycle={lifecycle}
        pendingAction={pendingAction}
        deposit={deposit}
        balance={balance}
        balanceState={balanceState}
        slotStartsAt={slotStartsAt}
        session={session}
        onActionSubmitted={onActionSubmitted}
        onUnauthorized={onUnauthorized}
      />
    </article>
  );
}
