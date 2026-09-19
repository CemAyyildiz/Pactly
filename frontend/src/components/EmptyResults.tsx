export interface EmptyResultsFilterChip {
  key: string;
  /** Names the filter, e.g. "session format" -- AC5: "loosen a filter
   * (named)". */
  label: string;
}

export interface EmptyResultsProps {
  /** The search text, echoed back verbatim (AC5: "It echoes the query"). */
  query: string;
  /** One chip per active filter besides availability (format/price/
   * deposit) -- each becomes its own "Loosen the ... filter" suggestion.
   * Empty means no such filter is active. */
  filterChips: EmptyResultsFilterChip[];
  onClearFilter: (key: string) => void;
  hasAvailabilityFilter: boolean;
  onClearAvailability: () => void;
  /** "Browse all of <category>" or "Browse all providers" -- computed by
   * the caller, since only it knows whether a category is selected and
   * whether anything else is even active to loosen. */
  browseLabel: string;
  onBrowseWider: () => void;
}

/**
 * AC5 / EXPERIENCE.md's "No results" state: never a blank area. Echoes the
 * query, then at least three concrete suggestions -- loosen a named
 * filter, try another time window, and browse the whole category (or all
 * providers). Every suggestion that has something to actually do is a
 * button; the rest are plain text so the list never shows a disabled or
 * dead control.
 */
export function EmptyResults({
  query,
  filterChips,
  onClearFilter,
  hasAvailabilityFilter,
  onClearAvailability,
  browseLabel,
  onBrowseWider,
}: EmptyResultsProps) {
  return (
    <div className="empty-results banner">
      <p className="empty-results__heading">
        {query ? <>No results for &ldquo;{query}&rdquo;.</> : "No providers match these filters."}
      </p>
      <p className="empty-results__try">Try:</p>
      <ul className="empty-results__list">
        {filterChips.length > 0 ? (
          filterChips.map((chip) => (
            <li key={chip.key}>
              <button type="button" className="button-ghost" onClick={() => onClearFilter(chip.key)}>
                Loosen the {chip.label} filter
              </button>
            </li>
          ))
        ) : (
          <li>Use fewer or different words in your search.</li>
        )}
        <li>
          {hasAvailabilityFilter ? (
            <button type="button" className="button-ghost" onClick={onClearAvailability}>
              Try another time window
            </button>
          ) : (
            "Try a different time window."
          )}
        </li>
        <li>
          <button type="button" className="button-ghost" onClick={onBrowseWider}>
            {browseLabel}
          </button>
        </li>
      </ul>
    </div>
  );
}
