/**
 * BigInt smallest-unit arithmetic -- the one place on the frontend that
 * turns an AD-7 integer string (USDC, 7 decimals) into human text. Never
 * parses the USDC side to a JS `number` (would lose precision for a large
 * amount), and never invents a currency symbol (DESIGN.md: "no screen
 * writes a currency symbol into a string").
 *
 * Product rule (2026-09 pivot): end users never see the escrow asset. Every
 * user-visible amount goes through {@link formatTry}/`<TryAmount>` and is
 * shown in Turkish lira at the backend's `GET /api/rate`; {@link formatMoney}
 * stays for internal/debug use only.
 */

/** The one copy of the balance-payment note shared by
 * `components/BookingActions.tsx`'s "Pay balance" step -- names the two
 * paths the UI actually offers for the balance (through Pactly before the
 * session, or in person to the provider), so any second surface must say
 * it identically rather than drift into a different wording. */
export const LOCAL_CURRENCY_UNAVAILABLE_NOTE = "Pay the balance through Pactly before the session, or settle it in person with the provider.";

/** TRY per 1 USDC, used only when `GET /api/rate` is unreachable (or has
 * not answered yet). Amounts shown at this rate carry a leading "≈" -- see
 * `components/TryAmount.tsx`. */
export const FALLBACK_TRY_PER_USDC = "48.54";

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

// ---------------------------------------------------------------------------
// TRY display. The rate (`GET /api/rate`'s `rate`, TRY per 1 USDC) is a
// decimal string such as "48.5410"; it is parsed once into an integer
// numerator plus a power-of-ten scale so every conversion below stays in
// BigInt -- no float ever touches the USDC side.
// ---------------------------------------------------------------------------

/** Kuruş per lira: TRY is shown and typed to 2 decimals. */
const TRY_DECIMALS = 2;

interface ScaledRate {
  /** `rate * 10^decimals`, as an integer. */
  numerator: bigint;
  decimals: number;
}

function parseRate(rate: string): ScaledRate | undefined {
  const trimmed = rate.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator === 0n) {
    return undefined;
  }
  return { numerator, decimals: fraction.length };
}

/** Integer division rounded half-up (both operands non-negative). */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Converts a USDC smallest-unit integer string to TRY at `rate`, as a plain
 * decimal string with exactly two places (`"2912.46"`). Computed entirely in
 * integer kuruş, rounded half-up to the kuruş. An unparseable rate yields
 * `"0.00"` rather than throwing -- a display helper must never take a
 * screen down.
 */
export function usdcToTry(amountSmallestUnit: string, rate: string): string {
  const parsed = parseRate(rate);
  if (!parsed) {
    return "0.00";
  }
  const value = BigInt(amountSmallestUnit);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  // kuruş = amount * rate * 10^2 / 10^7, with rate = numerator / 10^decimals.
  const kurus = divideRounded(
    magnitude * parsed.numerator * 10n ** BigInt(TRY_DECIMALS),
    10n ** BigInt(SMALLEST_UNIT_DECIMALS + parsed.decimals),
  );
  const lira = kurus / 100n;
  const fraction = (kurus % 100n).toString().padStart(TRY_DECIMALS, "0");
  return `${negative ? "-" : ""}${lira}.${fraction}`;
}

/** `"2,912.46 TRY"` -- English digit grouping, ISO code rather than a
 * symbol (the app's copy rule). The one formatter every user-visible
 * amount goes through (via `<TryAmount>`). */
export function formatTry(amountSmallestUnit: string, rate: string): string {
  const decimal = usdcToTry(amountSmallestUnit, rate);
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction = "00"] = (negative ? decimal.slice(1) : decimal).split(".");
  return `${negative ? "-" : ""}${groupThousands(whole)}.${fraction} TRY`;
}

/**
 * The inverse for inputs: a TRY amount someone typed (`"2400"`,
 * `"2,400.50"`; at most two decimals, thousands commas tolerated) to the
 * USDC smallest-unit integer string the API takes, at `rate`. Rounded
 * half-up to the smallest unit. `undefined` for anything that is not a
 * non-negative decimal, or for an unusable rate.
 *
 * Note for callers that round-trip a stored amount: display (USDC -> TRY,
 * rounded to the kuruş) and save (TRY -> USDC) are lossy in opposite
 * directions, and the rate itself may move between the two -- an untouched
 * field should resubmit the stored USDC string, not re-convert its text.
 */
export function tryToUsdcSmallestUnit(tryInput: string, rate: string): string | undefined {
  const parsed = parseRate(rate);
  if (!parsed) {
    return undefined;
  }
  const trimmed = tryInput.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return undefined;
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const kurus = BigInt(`${whole}${fraction.padEnd(TRY_DECIMALS, "0")}`);
  // smallest = kuruş * 10^7 * 10^decimals / (10^2 * numerator)
  const smallest = divideRounded(
    kurus * 10n ** BigInt(SMALLEST_UNIT_DECIMALS + parsed.decimals),
    10n ** BigInt(TRY_DECIMALS) * parsed.numerator,
  );
  return smallest.toString();
}
