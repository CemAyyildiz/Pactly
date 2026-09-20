import { useEffect, useState } from "react";

import { useQuote } from "../api/hooks";

export interface IndicativeEquivalentProps {
  /** Integer string, USDC smallest units (AD-7) -- the same amount the
   * caller already shows in USDC beside this line. */
  amount: string;
}

/** Re-renders the age text without re-fetching -- same "cheap tick, no
 * network" shape as `Countdown.tsx`'s own interval. A quote is cached for
 * about 60s on the backend, so a tick this frequent never implies
 * freshness the quote doesn't have. */
const TICK_MS = 15_000;

function formatFiatAmount(decimal: string): string {
  const [whole = "0", fraction] = decimal.split(".");
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${withCommas}.${fraction}` : withCommas;
}

function formatQuoteAge(quotedAt: number, nowSeconds: number): string {
  const ageSeconds = Math.max(0, nowSeconds - quotedAt);
  if (ageSeconds < 10) return "quoted just now";
  if (ageSeconds < 60) return `quoted ${ageSeconds}s ago`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `quoted ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `quoted ${hours}h ago`;
}

/**
 * Story 2.2: the indicative local-currency line beside a USDC amount --
 * "≈ 14,350.00 TRY · indicative, quoted just now". Never SEP vocabulary
 * (NFR9), never a currency assumption (the code comes from the anchor's own
 * `sep38/info`, via `GET /quote`). A quote failure never blocks the flow:
 * the USDC amount the caller already renders stays exactly as it was, and
 * this line becomes one plain sentence instead -- no stack trace, no raw
 * anchor body.
 */
export function IndicativeEquivalent({ amount }: IndicativeEquivalentProps) {
  const { data, isPending, isError } = useQuote(amount);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), TICK_MS);
    return () => clearInterval(interval);
  }, []);

  if (isPending) {
    return null;
  }

  if (isError || !data) {
    return <p className="quote-equivalent quote-equivalent--unavailable">Local-currency equivalent isn't available right now.</p>;
  }

  return (
    <p className="quote-equivalent tabular-nums">
      ≈ {formatFiatAmount(data.fiat.amount)} {data.fiat.currency} · indicative, {formatQuoteAge(data.quotedAt, nowSeconds)}
    </p>
  );
}
