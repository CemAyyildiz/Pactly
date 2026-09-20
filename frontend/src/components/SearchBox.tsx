import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import type { DiscoverSuggestion } from "../api/types";

/** AC2: fires 250ms after the last keystroke. */
const DEBOUNCE_MS = 250;
/** Matches the backend's own `MIN_SUGGESTION_QUERY_LENGTH` -- no point
 * opening a dropdown for a query the backend would answer with `[]`. */
const MIN_SUGGESTION_QUERY_LENGTH = 2;

const GROUP_LABELS: Record<DiscoverSuggestion["kind"], string> = {
  category: "Categories",
  service: "Services",
  provider: "Providers",
};

export interface SearchBoxProps {
  /** The committed, URL-backed query. */
  value: string;
  /** Called 250ms after the last keystroke, or immediately when the user
   * picks a suggestion or clears the field -- never only on Enter (the
   * spec's own "Always" rule: "Enter is never required"). */
  onCommit: (query: string) => void;
  suggestions: DiscoverSuggestion[];
  suggestionsLoading: boolean;
  onSelectSuggestion: (suggestion: DiscoverSuggestion) => void;
}

/**
 * DESIGN.md's search box, Story 3.3: a debounced free-text query with a
 * grouped, counted autocomplete dropdown. Keyboard-navigable per the
 * Accessibility Floor -- arrow keys move `aria-activedescendant` across
 * the flattened suggestion list, Escape closes the dropdown without
 * clearing the text, and the dropdown itself uses DESIGN.md's "offset
 * solid block" elevation (a transient layer above the page), not a blurred
 * shadow.
 */
export function SearchBox({ value, onCommit, suggestions, suggestionsLoading, onSelectSuggestion }: SearchBoxProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listboxId = useId();

  // `value` can change from outside (a suggestion pick elsewhere, the back
  // button restoring an older `q`) -- resync the draft then, but never
  // while the debounce timer for the user's own typing is still pending
  // (that would erase what they just typed out from under them).
  useEffect(() => {
    if (timerRef.current === undefined) {
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  function commitNow(next: string) {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    onCommit(next);
  }

  function handleChange(next: string) {
    setDraft(next);
    setOpen(true);
    setActiveIndex(-1);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      onCommit(next);
    }, DEBOUNCE_MS);
  }

  function handleSelect(suggestion: DiscoverSuggestion) {
    // Clear the pending debounce timer exactly as `commitNow` does --
    // otherwise it fires ~250ms later with the older typed text and
    // overwrites the suggestion the user just picked.
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    setDraft(suggestion.kind === "category" ? "" : suggestion.label);
    onSelectSuggestion(suggestion);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      if (event.key === "Escape") {
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      handleSelect(suggestions[activeIndex]!);
    }
  }

  const groups = (["category", "service", "provider"] as const)
    .map((kind) => ({ kind, label: GROUP_LABELS[kind], items: suggestions.filter((s) => s.kind === kind) }))
    .filter((group) => group.items.length > 0);

  const activeSuggestion = activeIndex >= 0 ? suggestions[activeIndex] : undefined;
  const showDropdown = open && draft.trim().length >= MIN_SUGGESTION_QUERY_LENGTH;

  return (
    <div className="search-box">
      <div className="search-box__field">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          type="search"
          className="search-box__input"
          role="combobox"
          aria-label="Search by name, service or category"
          aria-expanded={showDropdown && (suggestionsLoading || suggestions.length > 0)}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeSuggestion ? `${listboxId}-${activeSuggestion.kind}-${activeSuggestion.value}` : undefined
          }
          placeholder="Neighbourhood, shop or service"
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Defer so a suggestion's own `onClick` still registers before
            // the dropdown disappears out from under it.
            setTimeout(() => setOpen(false), 100);
          }}
          onKeyDown={handleKeyDown}
        />
        {draft.length > 0 && (
          <button
            type="button"
            className="search-box__clear"
            aria-label="Clear search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitNow("")}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>

      {showDropdown && (suggestionsLoading || suggestions.length > 0) && (
        <div className="search-box__suggestions" id={listboxId} role="listbox" aria-label="Suggestions">
          {suggestions.length === 0 ? (
            <p className="search-box__suggestions-empty">Searching…</p>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className="search-box__group">
                <p className="search-box__group-label">{group.label}</p>
                {group.items.map((item) => {
                  const index = suggestions.indexOf(item);
                  const id = `${listboxId}-${item.kind}-${item.value}`;
                  return (
                    <button
                      key={id}
                      id={id}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`search-box__suggestion${index === activeIndex ? " search-box__suggestion--active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleSelect(item)}
                    >
                      <span>{item.label}</span>
                      <span className="search-box__suggestion-count tabular-nums">{item.count}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
