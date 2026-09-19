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
 * can a photo). Drops only a *leading* title-like word ("Dr.") so "Dr.
 * Elif Aydın" reads as "EA", not "DE" -- a trailing suffix ("Jr.") or an
 * abbreviation elsewhere in the name is never dropped, only ever used.
 * Falls back to the bare name's first letter if nothing else is left to
 * take initials from (e.g. an all-abbreviation name). */
function initialsFor(displayName: string): string {
  const trimmed = displayName.trim();
  const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
  const nameWords = words.length > 1 && words[0]!.endsWith(".") ? words.slice(1) : words;

  let initials = "";
  if (nameWords.length === 1) {
    initials = nameWords[0]!.replace(/\./g, "").slice(0, 2).toUpperCase();
  } else if (nameWords.length > 1) {
    initials = `${nameWords[0]![0]}${nameWords[1]![0]}`.toUpperCase();
  }
  return initials || trimmed.slice(0, 1).toUpperCase();
}

/** DESIGN.md's `card-provider`, per Story 3.2's own card content order:
 * monogram + APPROVED badge, name, title/format/length, badge row
 * (verified sessions + the plainly-stated cancellation count), location,
 * price, deposit pill, up to three earliest slots.
 *
 * Story 3.9: the card is Discover v2's own three-column grid -- the
 * monogram, the body, and a right-hand price rail -- with the deposit pill
 * and slots as a footer row spanning the body and price columns beneath
 * them (`styles/base.css`'s own `.provider-card` grid).
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
      </div>

      <div className="provider-card__price-rail">
        <div className="provider-card__price tabular-nums">{formatMoney(provider.price.amount, provider.price.asset)}</div>
      </div>

      <div className="provider-card__footer">
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
