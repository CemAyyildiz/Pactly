import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { useCategories, useDiscoverProviders, useProviderSuggestions } from "../../api/hooks";
import type { DiscoverAvailability, DiscoverSuggestion } from "../../api/types";
import { CategoryTabs } from "../../components/CategoryTabs";
import { EmptyResults } from "../../components/EmptyResults";
import { FilterRail } from "../../components/FilterRail";
import { FilterSheet } from "../../components/FilterSheet";
import { ProviderCard } from "../../components/ProviderCard";
import { ProviderCardSkeleton } from "../../components/ProviderCardSkeleton";
import { SearchBox } from "../../components/SearchBox";

/** AC5: six skeleton cards match the real card layout on first load. */
const SKELETON_COUNT = 6;

const AVAILABILITY_VALUES = new Set<DiscoverAvailability>(["24h", "week"]);

/**
 * `/` -- the Discover page. Story 3.2 built the category rail, the card
 * grid, and its URL state; Story 3.3 adds the search box (with debounced
 * autocomplete), the filter rail/bottom sheet, and the richer "no results"
 * state, all sitting on top of 3.2's list without replacing it.
 *
 * Every filter and the query live in the URL alongside 3.2's own
 * `category` (`q`, `format` [repeated], `minPrice`, `maxPrice`,
 * `maxDepositBps`, `when`) so the back button restores them and results
 * update without a reload (AC4). An unknown or invalid value is simply
 * absent from what this page reads back out of `searchParams` -- the
 * backend applies the same "ignore, never error" rule to whatever actually
 * reaches it (the spec's own "Always" rule).
 */
export function DiscoverPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
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

  const q = searchParams.get("q") ?? "";
  const formats = searchParams.getAll("format");
  const minPrice = searchParams.get("minPrice") ?? undefined;
  const maxPrice = searchParams.get("maxPrice") ?? undefined;
  const maxDepositBpsRaw = searchParams.get("maxDepositBps");
  const maxDepositBps =
    maxDepositBpsRaw !== null && /^\d+$/.test(maxDepositBpsRaw) ? Number(maxDepositBpsRaw) : undefined;
  const whenRaw = searchParams.get("when");
  const availability = whenRaw && AVAILABILITY_VALUES.has(whenRaw as DiscoverAvailability) ? (whenRaw as DiscoverAvailability) : undefined;

  function updateParams(mutate: (params: URLSearchParams) => void): void {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    setSearchParams(next);
  }

  function selectCategory(slug: string | undefined): void {
    updateParams((params) => {
      if (slug === undefined) {
        params.delete("category");
      } else {
        params.set("category", slug);
      }
    });
  }

  function setQuery(next: string): void {
    updateParams((params) => {
      if (next.trim()) {
        params.set("q", next);
      } else {
        params.delete("q");
      }
    });
  }

  function toggleFormat(format: string): void {
    updateParams((params) => {
      const current = params.getAll("format");
      params.delete("format");
      const next = current.includes(format) ? current.filter((value) => value !== format) : [...current, format];
      for (const value of next) {
        params.append("format", value);
      }
    });
  }

  function setPriceRange(min: string | undefined, max: string | undefined): void {
    updateParams((params) => {
      if (min !== undefined) {
        params.set("minPrice", min);
      } else {
        params.delete("minPrice");
      }
      if (max !== undefined) {
        params.set("maxPrice", max);
      } else {
        params.delete("maxPrice");
      }
    });
  }

  function setMaxDepositBps(bps: number | undefined): void {
    updateParams((params) => {
      if (bps !== undefined) {
        params.set("maxDepositBps", String(bps));
      } else {
        params.delete("maxDepositBps");
      }
    });
  }

  function setAvailability(value: DiscoverAvailability | undefined): void {
    updateParams((params) => {
      if (value) {
        params.set("when", value);
      } else {
        params.delete("when");
      }
    });
  }

  function clearFilter(key: string): void {
    updateParams((params) => {
      if (key === "format") params.delete("format");
      if (key === "price") {
        params.delete("minPrice");
        params.delete("maxPrice");
      }
      if (key === "deposit") params.delete("maxDepositBps");
    });
  }

  function handleSelectSuggestion(suggestion: DiscoverSuggestion): void {
    if (suggestion.kind === "category") {
      updateParams((params) => {
        params.set("category", suggestion.value);
        params.delete("q");
      });
    } else {
      setQuery(suggestion.value);
    }
  }

  // Waiting on categories to resolve a requested slug: hold the providers
  // query back entirely rather than issuing it against a not-yet-decided
  // filter.
  const waitingForCategoryResolution = Boolean(requestedSlug) && !categoriesReady && !categoriesQuery.isError;
  const providersQuery = useDiscoverProviders(
    {
      category: selectedSlug,
      q: q || undefined,
      formats: formats.length > 0 ? formats : undefined,
      minPrice,
      maxPrice,
      maxDepositBps,
      when: availability,
    },
    { enabled: !waitingForCategoryResolution },
  );
  const suggestionsQuery = useProviderSuggestions(q);

  const selectedCategoryName = categories.find((category) => category.slug === selectedSlug)?.name;
  const providers = providersQuery.data?.providers ?? [];
  const showProvidersSkeleton = waitingForCategoryResolution || providersQuery.isLoading;

  const activeFilterCount = [formats.length > 0, minPrice !== undefined || maxPrice !== undefined, maxDepositBps !== undefined, availability !== undefined].filter(Boolean).length;

  const filterChips = [
    formats.length > 0 ? { key: "format", label: "session format" } : undefined,
    minPrice !== undefined || maxPrice !== undefined ? { key: "price", label: "price range" } : undefined,
    maxDepositBps !== undefined ? { key: "deposit", label: "deposit cap" } : undefined,
  ].filter((chip): chip is { key: string; label: string } => chip !== undefined);

  const hasAnythingToLoosen = Boolean(q) || filterChips.length > 0 || availability !== undefined;
  const browseLabel = selectedCategoryName && hasAnythingToLoosen ? `Browse all of ${selectedCategoryName}` : "Browse all providers";

  function handleBrowseWider(): void {
    if (selectedCategoryName && hasAnythingToLoosen) {
      updateParams((params) => {
        params.delete("q");
        params.delete("format");
        params.delete("minPrice");
        params.delete("maxPrice");
        params.delete("maxDepositBps");
        params.delete("when");
      });
    } else {
      setSearchParams(new URLSearchParams());
    }
  }

  const filterFieldsProps = {
    formats,
    onToggleFormat: toggleFormat,
    minPrice,
    maxPrice,
    onPriceRangeChange: setPriceRange,
    maxDepositBps,
    onMaxDepositBpsChange: setMaxDepositBps,
    availability,
    onAvailabilityChange: setAvailability,
  };

  return (
    <div className="page discover">
      <h1 className="discover__heading">Discover</h1>

      <div className="discover__search-row">
        <SearchBox
          value={q}
          onCommit={setQuery}
          suggestions={suggestionsQuery.data?.suggestions ?? []}
          suggestionsLoading={suggestionsQuery.isLoading}
          onSelectSuggestion={handleSelectSuggestion}
        />
        <button
          type="button"
          className="discover__filters-trigger button-ghost"
          onClick={() => setFilterSheetOpen(true)}
        >
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>
      </div>

      {categoriesQuery.isError ? (
        <div className="banner banner--alert">
          <p>Connection dropped. Your deposit is untouched.</p>
          <button type="button" className="button-ghost" onClick={() => categoriesQuery.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="discover__layout">
          <div className="discover__rail">
            <CategoryTabs categories={categories} selectedSlug={selectedSlug} onSelect={selectCategory} />
            <FilterRail {...filterFieldsProps} />
          </div>

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
              <EmptyResults
                query={q}
                filterChips={filterChips}
                onClearFilter={clearFilter}
                hasAvailabilityFilter={availability !== undefined}
                onClearAvailability={() => setAvailability(undefined)}
                browseLabel={browseLabel}
                onBrowseWider={handleBrowseWider}
              />
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

      <FilterSheet open={filterSheetOpen} onClose={() => setFilterSheetOpen(false)} {...filterFieldsProps} />
    </div>
  );
}
