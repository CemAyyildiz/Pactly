import { Link, useNavigate } from "react-router";

import type { ProviderCard as ProviderCardData } from "../api/types";
import { formatMoney } from "../lib/money";
import { formatSessionFormat } from "../lib/sessionFormat";
import { DepositPill } from "./DepositPill";
import { SlotChip } from "./SlotChip";

export interface ProviderCardProps {
  provider: ProviderCardData;
}

/** Two-letter initials for the monogram tile -- there is no photo field
 * (Story 3.2's own Design Notes: "badges cannot be invented", and neither
 * can a photo). Drops a leading title-like word ("Dr.") so "Dr. Elif
 * Aydın" reads as "EA", not "DE". */
function initialsFor(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !word.endsWith("."));
  if (words.length === 0) {
    return "";
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/** DESIGN.md's `card-provider`, per Story 3.2's own card content order:
 * monogram + APPROVED badge, name, title/format/length, badge row
 * (verified sessions + the plainly-stated cancellation count), location,
 * price, deposit pill, up to three earliest slots.
 *
 * The whole card links to `/providers/:id` through a "stretched link" --
 * an absolutely-positioned, otherwise empty `<a>` painted first, so the
 * slot chips (real `<button>`s painted after it, lifted with
 * `position: relative`) sit visually and for hit-testing above it and
 * never also trigger the card's own navigation. This avoids ever nesting a
 * `<button>` inside an `<a>` (invalid HTML) while still making the whole
 * card a single, keyboard-reachable link with one visible focus ring. */
export function ProviderCard({ provider }: ProviderCardProps) {
  const navigate = useNavigate();
  const initials = initialsFor(provider.displayName);

  return (
    <article className="provider-card">
      <Link to={`/providers/${provider.id}`} className="provider-card__link" aria-label={`View ${provider.displayName}`} />

      <div className="provider-card__monogram" aria-hidden="true">
        <span className="badge badge--approved provider-card__approved-badge">Approved</span>
        <span className="provider-card__initials">{initials}</span>
      </div>

      <div className="provider-card__body">
        <h3 className="provider-card__name">{provider.displayName}</h3>
        <p className="provider-card__meta">
          {provider.title} · {formatSessionFormat(provider.sessionFormat)} · {provider.sessionLengthMinutes} min
        </p>

        <div className="provider-card__badges">
          <span className="badge badge--verified">{provider.verifiedSessionCount} verified sessions</span>
          {/* Stated plainly, never styled as an alarm (DESIGN.md Components:
           * "it never takes the louder colour or the larger type"). */}
          <span className="provider-card__cancellations">{provider.providerCancellationCount} cancellations</span>
        </div>

        <p className="provider-card__location">{provider.location}</p>

        <div className="provider-card__price tabular-nums">{formatMoney(provider.price.amount, provider.price.asset)}</div>

        <DepositPill
          amount={provider.deposit.amount}
          asset={provider.deposit.asset}
          cancellationWindowHours={provider.cancellationWindowHours}
        />

        {provider.earliestSlots.length > 0 && (
          <div className="provider-card__slots">
            {provider.earliestSlots.map((startsAt) => (
              <SlotChip
                key={startsAt}
                startsAt={startsAt}
                onSelect={() => navigate(`/providers/${provider.id}?slot=${startsAt}`)}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
