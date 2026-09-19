/**
 * BigInt smallest-unit -> "1,234.50 USDC" formatting -- the one place on
 * the frontend that turns an AD-7 integer string into human text. Never
 * parses to a JS `number` (would lose precision for a large amount), and
 * never invents a currency symbol (DESIGN.md: "no screen writes a currency
 * symbol into a string").
 */

/** USDC on Stellar: 7 decimal places, matching `backend/src/services/
 * profile.ts`'s `computeDepositAmount`. */
const SMALLEST_UNIT_DECIMALS = 7;
/** Digits actually shown, per DESIGN.md's numeric examples
 * (`600.00 TRY`, `14.35 USDC`) -- the smallest-unit precision is kept
 * end to end in the amount string itself, only the display is rounded. */
const DISPLAY_DECIMALS = 2;

/** Formats an integer smallest-unit string as `"1,234.50 USDC"`. Truncates
 * (never rounds up) to {@link DISPLAY_DECIMALS} places, so the displayed
 * figure never overstates what the amount string actually holds. */
export function formatMoney(amount: string, asset: string): string {
  const value = BigInt(amount);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(SMALLEST_UNIT_DECIMALS);
  const whole = magnitude / divisor;
  const fractionDigits = (magnitude % divisor).toString().padStart(SMALLEST_UNIT_DECIMALS, "0");
  const fraction = fractionDigits.slice(0, DISPLAY_DECIMALS);
  const wholeWithCommas = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeWithCommas}.${fraction} ${asset}`;
}

/** `depositRateBps` as a plain percentage string, e.g. `2000` -> `"20%"`. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/** The rules form's own two directions of conversion between a human
 * decimal string (what someone types, e.g. `"90"` or `"90.5"`) and the
 * integer smallest-unit string the API takes and returns (AD-7). Kept next
 * to {@link formatMoney} since both are "smallest-unit string" arithmetic,
 * not a second money module (the spec's own "one BigInt formatter stays
 * small" design note). */
export function parseDecimalToSmallestUnit(input: string): string | undefined {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    return undefined;
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.padEnd(SMALLEST_UNIT_DECIMALS, "0");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const combined = `${normalizedWhole}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  return combined.length === 0 ? "0" : combined;
}

export function smallestUnitToDecimalInput(amount: string): string {
  const value = BigInt(amount);
  const divisor = 10n ** BigInt(SMALLEST_UNIT_DECIMALS);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(SMALLEST_UNIT_DECIMALS, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}
