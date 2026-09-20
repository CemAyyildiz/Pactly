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
  /** `"pill"` (default) is `editorial-v1.html`'s own black `.pill` -- the
   * provider profile aside and the booking lane, wherever the deposit
   * needs the escrow's own weight. `"row"` is its plain in-row `.dep`:
   * the provider list row's own price rail, which never puts a black
   * block inside a hairline-separated row. Both always pair the amount
   * with the free-cancellation window (the spec's own "Always" rule). */
  variant?: "pill" | "row";
}

/** DESIGN.md's `pill-deposit` -- amount and free-cancellation window
 * together, always. */
export function DepositPill({ amount, asset, cancellationWindowHours, freeCancellationEnded, variant = "pill" }: DepositPillProps) {
  const windowLabel = freeCancellationEnded
    ? "free-cancellation window has passed"
    : cancellationWindowHours === 0
      ? "no free cancellation"
      : `full refund up to ${cancellationWindowHours}h before`;
  const amountLabel = formatMoney(amount, asset);

  if (variant === "row") {
    return (
      <p className="deposit-row tabular-nums">
        <b className="deposit-row__amount">{amountLabel}</b> deposit
        <span className="deposit-row__caption"> · {windowLabel}</span>
      </p>
    );
  }

  return (
    <p className="deposit-pill tabular-nums">
      <b className="deposit-pill__amount">{amountLabel}</b> deposit
      <span className="deposit-pill__caption">{windowLabel}</span>
    </p>
  );
}
