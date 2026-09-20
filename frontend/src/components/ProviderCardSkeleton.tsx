/** Six of these show on the Discover page's first load (AC5), matching
 * `ProviderCard`'s own layout so the page never jumps once real cards
 * arrive. The pulse animation honours `prefers-reduced-motion` in CSS
 * (`.skeleton-block`, `styles/base.css`), never here. */
export function ProviderCardSkeleton() {
  return (
    <article className="provider-card provider-card--skeleton" aria-hidden="true">
      <div className="provider-card__monogram provider-card__monogram--skeleton skeleton-block" />
      <div className="provider-card__body">
        <div className="skeleton-block skeleton-block--name" />
        <div className="skeleton-block skeleton-block--meta" />
        <div className="provider-card__slots">
          <div className="skeleton-block skeleton-block--chip" />
          <div className="skeleton-block skeleton-block--chip" />
          <div className="skeleton-block skeleton-block--chip" />
        </div>
      </div>
      <div className="provider-card__price-rail">
        <div className="skeleton-block skeleton-block--price" />
        <div className="skeleton-block skeleton-block--pill" />
      </div>
    </article>
  );
}
