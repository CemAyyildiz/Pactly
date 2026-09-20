/** Six of these show on the Discover page's first load (AC5), matching
 * `ProviderCard`'s own compact-card layout so the page never jumps once
 * real cards arrive. The pulse animation honours `prefers-reduced-motion`
 * in CSS (`.skeleton-block`, `styles/base.css`), never here. */
export function ProviderCardSkeleton() {
  return (
    <article className="editorial-card" aria-hidden="true">
      <div className="editorial-card__top">
        <div className="skeleton-block skeleton-block--tile" />
        <div style={{ flex: 1 }}>
          <div className="skeleton-block skeleton-block--name" />
          <div className="skeleton-block skeleton-block--meta" />
        </div>
      </div>
      <div className="skeleton-block skeleton-block--meta" style={{ width: "60%" }} />
      <div className="skeleton-block skeleton-block--pill-sm" />
      <div className="editorial-card__foot">
        <div className="skeleton-block skeleton-block--price" />
      </div>
    </article>
  );
}
