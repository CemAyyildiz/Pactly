import { useEffect, useState } from "react";

export interface CountdownProps {
  /** UTC epoch seconds -- `bookings.cancel_deadline`. */
  cancelDeadline: number;
}

/** Turns `alert` under six hours -- the spec's own "Always" rule. */
const ALERT_THRESHOLD_SECONDS = 6 * 60 * 60;

/** "No more than one announcement per minute" (the spec's own "Always"
 * rule) -- the countdown's own text only changes on this tick, so the
 * `aria-live="polite"` region it lives in is never updated more often than
 * this. */
const TICK_MS = 60_000;

function formatDurationLabel(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${Math.max(minutes, 0)}m`;
}

/**
 * The free-cancellation countdown (Boundaries & Constraints): "Free
 * cancellation · 2d 19h" while time remains, an alert tone under six hours,
 * and "Window closed" plus the policy consequence once the deadline has
 * passed -- worded so it never claims any money has actually moved, since
 * automatic policy enforcement is not something this backend does (Epic 3
 * context: "Nothing here is automatic").
 */
export function Countdown({ cancelDeadline }: CountdownProps) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const secondsLeft = cancelDeadline - now;

  if (secondsLeft <= 0) {
    return (
      <p className="countdown countdown--alert" aria-live="polite">
        Window closed · a cancellation now follows this booking's resolution policy, not an automatic refund
      </p>
    );
  }

  const alert = secondsLeft < ALERT_THRESHOLD_SECONDS;
  return (
    <p className={`countdown tabular-nums${alert ? " countdown--alert" : ""}`} aria-live="polite">
      Free cancellation · {formatDurationLabel(secondsLeft)}
    </p>
  );
}
