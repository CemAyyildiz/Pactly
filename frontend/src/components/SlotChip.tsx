import { formatSlotTime } from "../lib/time";

export interface SlotChipProps {
  startsAt: number;
  selected?: boolean;
  onSelect?: (startsAt: number) => void;
}

/** DESIGN.md's `chip-slot`: an open slot is mustard, keyboard-reachable
 * (a real `<button>`, not a `<div>` with a click handler), at least 44px
 * per the Accessibility Floor. This story only ever renders open slots --
 * nothing here is "taken" yet (no booking exists that could hold one). */
export function SlotChip({ startsAt, selected, onSelect }: SlotChipProps) {
  return (
    <button
      type="button"
      className={`slot-chip tabular-nums${selected ? " slot-chip--selected" : ""}`}
      aria-pressed={selected ?? false}
      onClick={() => onSelect?.(startsAt)}
    >
      {formatSlotTime(startsAt)}
    </button>
  );
}
