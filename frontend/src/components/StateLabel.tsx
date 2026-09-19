import type { BookingLifecycle } from "../api/types";

export interface StateLabelProps {
  lifecycle: BookingLifecycle;
  /** Which side is looking at this booking -- a resolved dispute's outcome
   * reads differently depending on whose deposit it is (the spec's own
   * "Resolved" row: "Refunded to you" for the client, "Refunded to the
   * client" for the provider). */
  viewer: "client" | "provider";
}

/** The spec's own "Resolved" wording, one direction per viewer per outcome
 * -- never inferred, so a new outcome value can never silently produce a
 * sentence nobody wrote. */
const RESOLVED_OUTCOME_LABEL: Record<"client" | "provider", Record<"refund-client" | "pay-provider", string>> = {
  client: { "refund-client": "Refunded to you", "pay-provider": "Paid to the provider" },
  provider: { "refund-client": "Refunded to the client", "pay-provider": "Paid to you" },
};

/**
 * The spec's own lifecycle label mapping, from the latest recorded action
 * (Boundaries & Constraints): no action yet (a hold with nothing recorded)
 * reads "Waiting for your lock"; `funded` / `approved` / `disputed` /
 * `released` map one-to-one; `resolved` adds the outcome in words. Exported
 * separately from the component so a page can also use the plain text (a
 * `<title>`, a test) without rendering the pill.
 */
export function bookingStateLabel({ lifecycle, viewer }: StateLabelProps): string {
  switch (lifecycle.action) {
    case "funded":
      return "Funded";
    case "approved":
      return "Ready to release";
    case "disputed":
      return "In resolution";
    case "released":
      return "Released";
    case "resolved": {
      const outcomeLabel = lifecycle.outcome ? RESOLVED_OUTCOME_LABEL[viewer][lifecycle.outcome] : undefined;
      return outcomeLabel ? `Resolved · ${outcomeLabel}` : "Resolved";
    }
    default:
      return "Waiting for your lock";
  }
}

function stateTone(action: BookingLifecycle["action"]): "neutral" | "positive" | "alert" {
  if (action === "disputed") return "alert";
  if (action === "released" || action === "resolved") return "positive";
  return "neutral";
}

/**
 * DESIGN.md's Accessibility Floor: "state never colour-only" (AC3). The
 * colour (`state-label--*`) is always paired with the label text itself --
 * removing the class still leaves a complete sentence.
 */
export function StateLabel(props: StateLabelProps) {
  const tone = stateTone(props.lifecycle.action);
  return <span className={`state-label state-label--${tone}`}>{bookingStateLabel(props)}</span>;
}
