import { useEffect } from "react";

import { FilterFields, type FilterFieldsProps } from "./FilterRail";

export interface FilterSheetProps extends FilterFieldsProps {
  open: boolean;
  onClose: () => void;
}

/** Below 1024px, `FilterRail` is hidden and a "Filters" button (with an
 * active-filter count, rendered by the caller) opens this bottom sheet
 * instead (the spec's own Layout rule). DESIGN.md's modal backdrop:
 * `{colors.ink}` at 55% opacity, no blur. Escape closes it, matching the
 * Accessibility Floor's full-keyboard-nav requirement. */
export function FilterSheet({ open, onClose, ...fieldsProps }: FilterSheetProps) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="filter-sheet__backdrop" onClick={onClose}>
      <div
        className="filter-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Filters"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="filter-sheet__header">
          <h2 className="filter-sheet__heading">Filters</h2>
          <button type="button" className="button-primary" onClick={onClose}>
            Show results
          </button>
        </div>
        <div className="filter-sheet__body">
          <FilterFields {...fieldsProps} />
        </div>
      </div>
    </div>
  );
}
