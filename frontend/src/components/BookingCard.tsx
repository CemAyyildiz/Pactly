import { Countdown } from "./Countdown";
import { StateLabel } from "./StateLabel";
import { formatMoney } from "../lib/money";
import { stellarExplorerContractUrl } from "../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../lib/time";
import type { BalanceState, BookingLifecycle, Money } from "../api/types";

export interface BookingCardProps {
  /** Which side is looking at this card -- picks the "Resolved" wording
   * (`StateLabel`) and nothing else; the shape is otherwise identical for
   * both. */
  viewer: "client" | "provider";
  /** Provider display name (My bookings) or a short "who booked" label
   * (the panel's Bookings view). */
  heading: string;
  /** Provider title (My bookings) or the shortened client wallet (the
   * panel's Bookings view). */
  subheading?: string;
  /** UTC epoch seconds -- `null` only for a pre-3.4 booking with no slot. */
  slotStartsAt: number | null;
  deposit: Money;
  balance: Money;
  lifecycle: BookingLifecycle;
  balanceState: BalanceState;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  /** The explorer link (AC4) appears only when this exists. */
  contractId: string | null;
}

/** The balance row's own three-state wording (Epic 3 context: "Balance
 * 1,400.00 TRY · due before the session", three states) -- exported so
 * `BookingsPage.tsx`'s desktop table can render the identical wording in a
 * `<td>` instead of a card, without a second copy of this map. */
export const BALANCE_STATE_LABEL: Record<BalanceState, string> = {
  unpaid: "due before the session",
  paid_platform: "paid via Pactly",
  paid_cash: "paid in person",
};

/**
 * One booking's card (mobile-first "My bookings", and the panel's
 * `Bookings` view below 1024px). The deposit state (`StateLabel`, driven by
 * `lifecycle`) and the balance state are always two separate lines --
 * AD-3's "never merged" rule, enforced here by simply never combining them
 * into one sentence.
 */
export function BookingCard({ viewer, heading, subheading, slotStartsAt, deposit, balance, lifecycle, balanceState, cancelDeadline, contractId }: BookingCardProps) {
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

      <Countdown cancelDeadline={cancelDeadline} />

      {contractId && (
        <a className="booking-card__explorer-link" href={stellarExplorerContractUrl(contractId)} target="_blank" rel="noreferrer">
          View on Stellar Expert
        </a>
      )}
    </article>
  );
}
