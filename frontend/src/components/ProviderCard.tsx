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

/** DESIGN.md's `card-provider`, ported in Story 3.10 as
 * `editorial-v1.html`'s own `.row`: an editorial list row separated by a
 * hairline, not a stacked card. Three columns -- photo/monogram, body, a
 * right-hand price rail -- with the "Approved" mark, name, meta line
 * (title, format, length, location, verified sessions and the plainly-
 * stated cancellation count) and the earliest open slots all living in the
 * body column, and the price plus the deposit row living in the rail
 * (`styles/base.css`'s own `.provider-card` grid).
 *
 * The whole row links to `/providers/:id` through a "stretched link" --
 * an absolutely-positioned, otherwise empty `<a>` painted first, so the
 * slot chips (real `<button>`s painted after it, lifted with
 * `position: relative`) sit visually and for hit-testing above it and
 * never also trigger the row's own navigation. This avoids ever nesting a
 * `<button>` inside an `<a>` (invalid HTML) while still making the whole
 * row a single, keyboard-reachable link with one visible focus ring. */
export function ProviderCard({ provider }: ProviderCardProps) {
  const navigate = useNavigate();
  const initials = initialsFor(provider.displayName);

  return (
    <article className="provider-card">
      <Link to={`/providers/${provider.id}`} className="provider-card__link" aria-label={`View ${provider.displayName}`} />

      <div className="provider-card__monogram" aria-hidden="true">
        <span className="provider-card__initials">{initials}</span>
      </div>

      <div className="provider-card__body">
        {/* Discover only ever lists approved providers (EXPERIENCE.md: "An
         * admin approves; the profile appears on the marketplace") -- this
         * mark is unconditional here, matching every row of the mockup's
         * own list. */}
        <p className="approved-mark">
          <span className="approved-mark__dot" aria-hidden="true" />
          Approved provider
        </p>
        <h3 className="provider-card__name">{provider.displayName}</h3>
        <p className="provider-card__meta">
          {provider.title} · {formatSessionFormat(provider.sessionFormat)} · {provider.sessionLengthMinutes} min ·{" "}
          {provider.location} · {provider.verifiedSessionCount} verified sessions ·{" "}
          {/* Stated plainly, never styled as an alarm (DESIGN.md Components:
           * "it never takes the louder colour or the larger type"). */}
          {provider.providerCancellationCount} cancellations
        </p>

        {provider.earliestSlots.length > 0 && (
          <div className="provider-card__slots">
            {provider.earliestSlots.map((startsAt) => (
              <SlotChip
                key={startsAt}
                startsAt={startsAt}
                showDay
                onSelect={() => navigate(`/providers/${provider.id}?slot=${startsAt}`)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="provider-card__price-rail">
        <div className="provider-card__price tabular-nums">{formatMoney(provider.price.amount, provider.price.asset)}</div>
        <DepositPill
          variant="row"
          amount={provider.deposit.amount}
          asset={provider.deposit.asset}
          cancellationWindowHours={provider.cancellationWindowHours}
        />
      </div>
    </article>
  );
}
