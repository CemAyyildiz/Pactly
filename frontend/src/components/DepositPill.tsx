import { formatMoney } from "../lib/money";

export interface DepositPillProps {
  amount: string;
  asset: string;
  cancellationWindowHours: number;
  /** Review follow-up: `true` only once a real hold's own `cancelDeadline`
   * has already passed -- overrides the generic window label with the
   * fact that free cancellation is no longer available for *this*
   * booking, rather than repeating a policy statement that no longer
   * applies to it. */
  freeCancellationEnded?: boolean;
}

/** DESIGN.md's `pill-deposit`: black ground, mustard dot, one line --
 * amount and free-cancellation window together, always (the spec's own
 * "Always" rule: "The deposit amount and the free-cancellation window
 * always appear together, wherever a deposit is shown"). */
export function DepositPill({ amount, asset, cancellationWindowHours, freeCancellationEnded }: DepositPillProps) {
  const windowLabel = freeCancellationEnded
    ? "free-cancellation window has passed"
    : cancellationWindowHours === 0
      ? "no free cancellation"
      : `full refund up to ${cancellationWindowHours}h before`;
  return (
    <span className="deposit-pill tabular-nums">
      <span className="deposit-pill__dot" aria-hidden="true" />
      {formatMoney(amount, asset)} deposit · {windowLabel}
    </span>
  );
}
