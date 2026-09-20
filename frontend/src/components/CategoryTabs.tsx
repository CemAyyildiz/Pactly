import type { CategoryWithProviderCount } from "../api/types";

export interface CategoryTabsProps {
  categories: CategoryWithProviderCount[];
  /** `undefined` means "all categories" -- the spec's own default, and
   * also what an unknown URL slug falls back to (`DiscoverPage` resolves
   * that before this component ever sees it). */
  selectedSlug: string | undefined;
  onSelect: (slug: string | undefined) => void;
}

/** The category rail/tabs (Story 3.2's own scope: "The rail may show only
 * the category list" -- no search box, no other filters, that is Story
 * 3.3's job). One set of buttons; DESIGN.md's own breakpoint rule turns
 * this into a left rail from 1024px and horizontally-scrolling tabs below
 * it purely through `styles/base.css` (`.category-nav`), not two
 * components. Each button is a real `<button>` at least 44px tall, so it
 * is both keyboard-reachable and a proper touch target. */
export function CategoryTabs({ categories, selectedSlug, onSelect }: CategoryTabsProps) {
  const totalCount = categories.reduce((sum, category) => sum + category.providerCount, 0);

  return (
    <nav className="category-nav" aria-label="Categories">
      <button
        type="button"
        className={`category-tab${selectedSlug === undefined ? " category-tab--selected" : ""}`}
        aria-pressed={selectedSlug === undefined}
        onClick={() => onSelect(undefined)}
      >
        <span>Near you</span>
        <span className="category-tab__count tabular-nums">{totalCount}</span>
      </button>
      {categories.map((category) => (
        <button
          key={category.id}
          type="button"
          className={`category-tab${selectedSlug === category.slug ? " category-tab--selected" : ""}`}
          aria-pressed={selectedSlug === category.slug}
          onClick={() => onSelect(category.slug)}
        >
          <span>{category.name}</span>
          <span className="category-tab__count tabular-nums">{category.providerCount}</span>
        </button>
      ))}
    </nav>
  );
}
