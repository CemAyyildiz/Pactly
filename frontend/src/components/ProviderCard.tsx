import { Link, useNavigate } from "react-router";

import type { ProviderCard as ProviderCardData } from "../api/types";
import { formatMoney } from "../lib/money";
import { providerPhotoSrc } from "../lib/providerPhotos";
import { formatSessionFormat } from "../lib/sessionFormat";
import { DepositPill } from "./DepositPill";
import { SlotChip } from "./SlotChip";

export interface ProviderCardProps {
  provider: ProviderCardData;
}

/** Two-letter initials for the photo tile -- there is no photo field
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

function placeLabel(provider: ProviderCardData): string {
  const title = provider.title.toLowerCase();
  if (title.includes("clinic") || title.includes("transplant")) return "CLINIC";
  if (title.includes("salon")) return "SALON";
  if (title.includes("barber")) return "SHOP";
  switch (provider.category.slug) {
    case "fitness-and-beauty":
      return "SHOP";
    case "education-and-lessons":
      return "STUDIO";
    default:
      return "OFFICE";
  }
}

function depositRateLabel(priceAmount: string, depositAmount: string): string | undefined {
  try {
    const price = BigInt(priceAmount);
    const deposit = BigInt(depositAmount);
    if (price <= 0n) return undefined;
    const percent = Number((deposit * 100n) / price);
    return `deposit ${percent}%`;
  } catch {
    return undefined;
  }
}

/** DESIGN.md's `card-provider`, ported from `discover-v2-marketplace.html`'s
 * own `.card`: a white marketplace card with a photo tile, role pill,
 * escrow deposit capsule, open slots, and a blue "Lock with Pactly" CTA.
 *
 * The whole card links to `/providers/:id` through a "stretched link" --
 * an absolutely-positioned, otherwise empty `<a>` painted first, so the
 * slot chips and the CTA (real buttons/links painted after it, lifted with
 * `position: relative`) sit visually and for hit-testing above it and
 * never also trigger the card's own navigation. This avoids ever nesting a
 * `<button>` inside an `<a>` (invalid HTML) while still making the whole
 * card a single, keyboard-reachable link with one visible focus ring. */
export function ProviderCard({ provider }: ProviderCardProps) {
  const navigate = useNavigate();
  const initials = initialsFor(provider.displayName);
  const photoSrc = providerPhotoSrc(provider.id);
  const firstSlot = provider.earliestSlots[0];
  const lockHref = firstSlot ? `/book/${provider.id}?slot=${firstSlot}` : `/providers/${provider.id}`;
  const rateLabel = depositRateLabel(provider.price.amount, provider.deposit.amount);

  return (
    <article className="provider-card">
      <Link to={`/providers/${provider.id}`} className="provider-card__link" aria-label={`View ${provider.displayName}`} />

      <div className={`provider-card__monogram provider-card__monogram--${provider.category.slug}`} aria-hidden="true">
        {photoSrc ? <img src={photoSrc} alt="" className="provider-card__photo" /> : null}
        <span className="provider-card__place">{placeLabel(provider)}</span>
        {provider.verifiedSessionCount > 0 ? <span className="provider-card__verified">✓</span> : null}
        {photoSrc ? null : <span className="provider-card__initials">{initials}</span>}
      </div>

      <div className="provider-card__body">
        <h3 className="provider-card__name">{provider.displayName}</h3>
        <span className="provider-card__role">{provider.title}</span>
        <p className="provider-card__meta">
          {formatSessionFormat(provider.sessionFormat)} · {provider.sessionLengthMinutes} min. Deposit holds the
          chair if a client no-shows.
        </p>
        <div className="provider-card__stats">
          <span>
            <b>{provider.verifiedSessionCount} verified</b> · {provider.providerCancellationCount} cancellations
          </span>
          <span>{provider.location}</span>
          <span>
            {formatSessionFormat(provider.sessionFormat)} · {provider.sessionLengthMinutes} min
          </span>
        </div>
      </div>

      <div className="provider-card__price-rail">
        <div className="provider-card__price-lab">Service</div>
        <div className="provider-card__price tabular-nums">{formatMoney(provider.price.amount, provider.price.asset)}</div>
        {rateLabel ? <div className="provider-card__price-note">{rateLabel}</div> : null}
      </div>

      <div className="provider-card__deposit">
        <DepositPill
          variant="row"
          amount={provider.deposit.amount}
          asset={provider.deposit.asset}
          cancellationWindowHours={provider.cancellationWindowHours}
        />
      </div>

      <div className="provider-card__slots">
        {provider.earliestSlots.map((startsAt, index) => (
          <SlotChip
            key={startsAt}
            startsAt={startsAt}
            showDay
            selected={index === 0}
            onSelect={() => navigate(`/providers/${provider.id}?slot=${startsAt}`)}
          />
        ))}
        <Link
          to={lockHref}
          className={firstSlot ? "provider-card__cta" : "provider-card__cta provider-card__cta--ghost"}
        >
          {firstSlot ? "Lock with Pactly →" : "View calendar"}
        </Link>
      </div>
    </article>
  );
}
