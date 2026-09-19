import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";

import { useCategories, useDiscoverProviders } from "../../api/hooks";
import { CategoryTabs } from "../../components/CategoryTabs";
import { ProviderCard } from "../../components/ProviderCard";
import { ProviderCardSkeleton } from "../../components/ProviderCardSkeleton";

/** AC5: six skeleton cards match the real card layout on first load. */
const SKELETON_COUNT = 6;

/**
 * `/` -- the Discover page (Story 3.2), replacing 3.1's temporary home. No
 * sign-in anywhere here (PRD 3.2 AC6): category tabs, provider cards with
 * the deposit pill and up to three slot chips, skeletons on first load.
 * No search box, autocomplete or other filters -- that is Story 3.3's job
 * (the spec's own Never list).
 *
 * Category selection lives in the URL (`?category=<slug>`) so back/forward
 * restore it (AC2) for free, through `useSearchParams`'s own history
 * integration. An unknown slug is never sent to the backend as a filter --
 * it is treated as "all providers", with no error (the spec's own "Always"
 * rule). That resolution can only happen once `/categories` has itself
 * loaded, so the providers query stays disabled (and skeletons show)
 * until then -- otherwise a `?category=<valid slug>` URL would briefly
 * fetch and show the unfiltered list first, then the filtered one once
 * categories arrive.
 */
export function DiscoverPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const categoriesQuery = useCategories();
  const categories = categoriesQuery.data?.categories ?? [];
  const categoriesReady = categoriesQuery.isSuccess;

  const requestedSlug = searchParams.get("category") ?? undefined;
  // A slug is only ever resolved once the real category list is in --
  // before that, `categories` is empty and every slug would wrongly look
  // "unknown".
  const selectedSlug = useMemo(() => {
    if (!requestedSlug || !categoriesReady) {
      return undefined;
    }
    return categories.some((category) => category.slug === requestedSlug) ? requestedSlug : undefined;
  }, [requestedSlug, categoriesReady, categories]);

  // Waiting on categories to resolve a requested slug: hold the providers
  // query back entirely rather than issuing it against a not-yet-decided
  // filter.
  const waitingForCategoryResolution = Boolean(requestedSlug) && !categoriesReady && !categoriesQuery.isError;
  const providersQuery = useDiscoverProviders(selectedSlug, { enabled: !waitingForCategoryResolution });

  function selectCategory(slug: string | undefined): void {
    const next = new URLSearchParams(searchParams);
    if (slug === undefined) {
      next.delete("category");
    } else {
      next.set("category", slug);
    }
    setSearchParams(next);
  }

  const selectedCategoryName = categories.find((category) => category.slug === selectedSlug)?.name;
  const providers = providersQuery.data?.providers ?? [];
  const showProvidersSkeleton = waitingForCategoryResolution || providersQuery.isLoading;

  return (
    <div className="page discover">
      <h1 className="discover__heading">Discover</h1>

      {categoriesQuery.isError ? (
        <div className="banner banner--alert">
          <p>Connection dropped. Your deposit is untouched.</p>
          <button type="button" className="button-ghost" onClick={() => categoriesQuery.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="discover__layout">
          <CategoryTabs categories={categories} selectedSlug={selectedSlug} onSelect={selectCategory} />

          <div className="discover__results">
            {showProvidersSkeleton ? (
              <div className="provider-grid">
                {Array.from({ length: SKELETON_COUNT }, (_, index) => (
                  <ProviderCardSkeleton key={index} />
                ))}
              </div>
            ) : providersQuery.isError ? (
              <div className="banner banner--alert">
                <p>Connection dropped. Your deposit is untouched.</p>
                <button type="button" className="button-ghost" onClick={() => providersQuery.refetch()}>
                  Try again
                </button>
              </div>
            ) : providers.length === 0 ? (
              <div className="banner">
                <p>{selectedCategoryName ? `No approved providers in ${selectedCategoryName} yet.` : "No approved providers yet."}</p>
                {selectedSlug && (
                  <p>
                    <Link to="/">See all providers</Link>
                  </p>
                )}
              </div>
            ) : (
              <div className="provider-grid">
                {providers.map((provider) => (
                  <ProviderCard key={provider.id} provider={provider} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
