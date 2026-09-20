import { useCallback } from "react";

import { useTryRate } from "../api/hooks";
import { formatTry } from "../lib/money";

/** The one formatter for an amount that has to live inside a sentence
 * (a button label, a policy statement) rather than its own element --
 * same rate, same "≈" rule as {@link TryAmount}. */
export function useFormatTry(): (amountSmallestUnit: string) => string {
  const { rate, isFallback } = useTryRate();
  return useCallback((amountSmallestUnit: string) => `${isFallback ? "≈ " : ""}${formatTry(amountSmallestUnit, rate)}`, [rate, isFallback]);
}

export interface TryAmountProps {
  /** Integer string, USDC smallest units (AD-7) -- the amount as the API
   * holds it. The conversion to lira happens here and nowhere else. */
  amount: string;
  /** Appended to the element's own `tabular-nums`. */
  className?: string;
}

/**
 * THE way an amount reaches a screen: `"2,912.46 TRY"` at the backend's
 * current rate (`useTryRate`), prefixed "≈" only while the built-in
 * fallback rate is in use. Renders a `<span>` so it can sit inside any
 * `<strong>`, `<dd>` or `<td>` the caller already styles.
 */
export function TryAmount({ amount, className }: TryAmountProps) {
  const format = useFormatTry();
  return <span className={className ? `tabular-nums ${className}` : "tabular-nums"}>{format(amount)}</span>;
}
