import { useEffect, useState } from "react";

import { parseDecimalToSmallestUnit, smallestUnitToDecimalInput } from "../lib/money";
import { formatSessionFormat } from "../lib/sessionFormat";
import type { DiscoverAvailability } from "../api/types";

/** The complete universe of `sessionFormat` values the demo seed and the
 * rest of this frontend know about (`lib/sessionFormat.ts`'s own label
 * map) -- "the formats present" (the spec's own wording) reduces to this
 * fixed pair at this app's current scale; there is no separate endpoint
 * that reports which formats exist. */
const SESSION_FORMAT_OPTIONS = ["in_person", "video"];

const AVAILABILITY_OPTIONS: Array<{ value: DiscoverAvailability | undefined; label: string }> = [
  { value: undefined, label: "Any" },
  { value: "24h", label: "Today / next 24h" },
  { value: "week", label: "This week" },
];

export interface FilterFieldsProps {
  formats: string[];
  onToggleFormat: (format: string) => void;
  minPrice: string | undefined;
  maxPrice: string | undefined;
  onPriceRangeChange: (min: string | undefined, max: string | undefined) => void;
  maxDepositBps: number | undefined;
  onMaxDepositBpsChange: (bps: number | undefined) => void;
  availability: DiscoverAvailability | undefined;
  onAvailabilityChange: (value: DiscoverAvailability | undefined) => void;
}

/** The min/max USDC price inputs -- local draft text so a half-typed
 * number is never clobbered by the URL's own re-render, committed on blur
 * or Enter (AC4: "every change updates results without a reload", not
 * necessarily on every keystroke). */
function PriceRangeField({ minPrice, maxPrice, onPriceRangeChange }: Pick<FilterFieldsProps, "minPrice" | "maxPrice" | "onPriceRangeChange">) {
  const [minText, setMinText] = useState(minPrice !== undefined ? smallestUnitToDecimalInput(minPrice) : "");
  const [maxText, setMaxText] = useState(maxPrice !== undefined ? smallestUnitToDecimalInput(maxPrice) : "");

  useEffect(() => {
    setMinText(minPrice !== undefined ? smallestUnitToDecimalInput(minPrice) : "");
  }, [minPrice]);
  useEffect(() => {
    setMaxText(maxPrice !== undefined ? smallestUnitToDecimalInput(maxPrice) : "");
  }, [maxPrice]);

  function commit() {
    const min = minText.trim() === "" ? undefined : parseDecimalToSmallestUnit(minText);
    const max = maxText.trim() === "" ? undefined : parseDecimalToSmallestUnit(maxText);
    onPriceRangeChange(min, max);
  }

  return (
    <div className="filter-field__price-range">
      <label className="filter-field__price-input">
        <span>Min (USDC)</span>
        <input
          inputMode="decimal"
          value={minText}
          onChange={(event) => setMinText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      </label>
      <label className="filter-field__price-input">
        <span>Max (USDC)</span>
        <input
          inputMode="decimal"
          value={maxText}
          onChange={(event) => setMaxText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      </label>
    </div>
  );
}

/** The deposit-rate cap input, shown and stored as a whole percentage
 * (`depositRateBps / 100`) -- converted to basis points only at the URL
 * boundary. */
function DepositCapField({
  maxDepositBps,
  onMaxDepositBpsChange,
}: Pick<FilterFieldsProps, "maxDepositBps" | "onMaxDepositBpsChange">) {
  const [text, setText] = useState(maxDepositBps !== undefined ? String(maxDepositBps / 100) : "");

  useEffect(() => {
    setText(maxDepositBps !== undefined ? String(maxDepositBps / 100) : "");
  }, [maxDepositBps]);

  function commit() {
    const trimmed = text.trim();
    if (trimmed === "") {
      onMaxDepositBpsChange(undefined);
      return;
    }
    const percent = Number(trimmed);
    if (!Number.isFinite(percent) || percent < 0) {
      onMaxDepositBpsChange(undefined);
      return;
    }
    onMaxDepositBpsChange(Math.round(percent * 100));
  }

  return (
    <label className="filter-field__deposit-input">
      <span>Max deposit rate (%)</span>
      <input
        inputMode="decimal"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </label>
  );
}

/** The four Discover v2 filter sections this story keeps (When / Session
 * type / Service price / Deposit -- the mockup's Neighbourhood and Where
 * sections are dropped, per the spec's own Code Map). Shared between the
 * desktop rail and the mobile bottom sheet so the two surfaces can never
 * drift into different controls. */
export function FilterFields({
  formats,
  onToggleFormat,
  minPrice,
  maxPrice,
  onPriceRangeChange,
  maxDepositBps,
  onMaxDepositBpsChange,
  availability,
  onAvailabilityChange,
}: FilterFieldsProps) {
  return (
    <div className="filter-fields">
      <div className="filter-field">
        <h3 className="filter-field__heading">When</h3>
        <div className="filter-field__radio-group" role="radiogroup" aria-label="When">
          {AVAILABILITY_OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              role="radio"
              aria-checked={availability === option.value}
              className={`filter-field__radio${availability === option.value ? " filter-field__radio--selected" : ""}`}
              onClick={() => onAvailabilityChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-field">
        <h3 className="filter-field__heading">Session type</h3>
        <div className="filter-field__checkbox-group">
          {SESSION_FORMAT_OPTIONS.map((format) => (
            <label key={format} className="filter-field__checkbox">
              <input type="checkbox" checked={formats.includes(format)} onChange={() => onToggleFormat(format)} />
              {formatSessionFormat(format)}
            </label>
          ))}
        </div>
      </div>

      <div className="filter-field">
        <h3 className="filter-field__heading">Service price</h3>
        <PriceRangeField minPrice={minPrice} maxPrice={maxPrice} onPriceRangeChange={onPriceRangeChange} />
      </div>

      <div className="filter-field">
        <h3 className="filter-field__heading">Deposit</h3>
        <DepositCapField maxDepositBps={maxDepositBps} onMaxDepositBpsChange={onMaxDepositBpsChange} />
      </div>
    </div>
  );
}

/** The desktop (>=1024px) filter rail: sits under the category list, in
 * the same 232px left column (EXPERIENCE.md/the spec's own Layout rule),
 * hidden below that breakpoint in favour of `FilterSheet`'s bottom-sheet
 * trigger. */
export function FilterRail(props: FilterFieldsProps) {
  return (
    <aside className="filter-rail" aria-label="Filters">
      <FilterFields {...props} />
    </aside>
  );
}
