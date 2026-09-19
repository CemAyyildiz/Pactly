/** Mirrors `backend/src/services/profile.ts`'s response shapes exactly --
 * this file has no logic, only the types both provider screens render
 * against. */

export interface Money {
  /** Integer string, smallest unit (AD-7) -- never a float. */
  amount: string;
  asset: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
}

/** `GET /categories`'s Story 3.2 shape -- every category plus
 * `providerCount` (approved providers only). */
export interface CategoryWithProviderCount extends Category {
  providerCount: number;
}

export interface ProviderProfile {
  id: string;
  displayName: string;
  title: string;
  category: Category;
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: Money;
  deposit: Money;
  depositRateBps: number;
  cancellationWindowHours: number;
  verifiedSessionCount: number;
  isApproved: boolean;
  /** UTC epoch seconds, ascending. */
  slots: number[];
}

export interface CategoriesResponse {
  categories: CategoryWithProviderCount[];
}

/** `GET /providers[?category=<slug>]`'s Story 3.2 card shape -- mirrors
 * `backend/src/services/profile.ts`'s `ProviderCardView` exactly. Distinct
 * from {@link ProviderProfile}: no `depositRateBps`/`isApproved`/full
 * `slots`; adds `providerCancellationCount` and the capped
 * `earliestSlots`. */
export interface ProviderCard {
  id: string;
  displayName: string;
  title: string;
  category: Category;
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: Money;
  deposit: Money;
  cancellationWindowHours: number;
  verifiedSessionCount: number;
  providerCancellationCount: number;
  /** UTC epoch seconds, ascending, at most three. */
  earliestSlots: number[];
}

export interface ProvidersResponse {
  providers: ProviderCard[];
}

/** `GET /providers/suggest?q=`'s Story 3.3 shape -- mirrors
 * `backend/src/services/profile.ts`'s `DiscoverSuggestion` exactly. */
export interface DiscoverSuggestion {
  kind: "category" | "service" | "provider";
  label: string;
  value: string;
  count: number;
}

export interface SuggestResponse {
  suggestions: DiscoverSuggestion[];
}

/** Story 3.3's own availability window values (`?when=`) -- `undefined`
 * means "Any", the spec's own default (no filtering at all). */
export type DiscoverAvailability = "24h" | "week";

/** Every Story 3.3 filter `useDiscoverProviders` turns into `GET
 * /providers`'s query string, alongside 3.2's own `category`. Mirrors
 * `backend/src/services/profile.ts`'s `DiscoverFilters` (plus `category`,
 * which the backend takes as a separate positional argument). */
export interface DiscoverFiltersParams {
  category?: string;
  q?: string;
  formats?: string[];
  minPrice?: string;
  maxPrice?: string;
  maxDepositBps?: number;
  when?: DiscoverAvailability;
}

// ---------------------------------------------------------------------------
// Story 3.4: the client booking flow. Mirrors `backend/src/services/
// booking.ts`'s response shapes exactly, same discipline as the rest of
// this file.
// ---------------------------------------------------------------------------

export interface BookingProviderSummary {
  id: string;
  displayName: string;
  title: string;
}

export interface HoldSlotResponse {
  bookingId: string;
  /** UTC epoch seconds. */
  holdExpiresAt: number;
  deposit: Money;
  balance: Money;
  price: Money;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  provider: BookingProviderSummary;
  /** `true` only when the free-cancellation window had already passed at
   * the moment of the hold -- omitted (never `false`) otherwise. */
  freeCancellationEnded?: boolean;
}

/** Review follow-up: `deployed: true` means a signed deploy was already
 * submitted and accepted for this booking -- there is no XDR to sign
 * again, skip straight to `fund`. `deployed: false` carries the unsigned
 * deploy XDR (and its own real `txHash`) still waiting for a signature. */
export type LockResponse = { deployed: true; contractId: string } | { deployed: false; contractId: string; unsignedXdr: string; txHash: string };

export interface FundResponse {
  unsignedXdr: string;
}

export interface SubmitResponse {
  txHash: string;
}

export type EscrowLifecycleAction = "funded" | "approved" | "disputed" | "released" | "resolved";

export interface BookingView {
  id: string;
  /** `null` until the reconciler confirms it -- the UI only ever shows
   * "locked" from here, never from a lock/fund/submit response. */
  escrowState: "locked" | "released" | "refunded" | null;
  lifecycle: { contractId?: string; action?: EscrowLifecycleAction; outcome?: "refund-client" | "pay-provider" };
  holdExpiresAt: number | null;
  contractId: string | null;
  deposit: Money;
  balance: Money;
  price: Money;
  slotStartsAt: number | null;
  cancelDeadline: number;
  provider: BookingProviderSummary;
}

// ---------------------------------------------------------------------------
// Story 3.5: the two-sided status panel. Mirrors `backend/src/services/
// booking.ts`'s `BookingListItemBase`/`ClientBookingListItem`/
// `ProviderBookingListItem` exactly, same discipline as the rest of this
// file.
// ---------------------------------------------------------------------------

export type BalanceState = "unpaid" | "paid_platform" | "paid_cash";

export interface BookingLifecycle {
  contractId?: string;
  action?: EscrowLifecycleAction;
  outcome?: "refund-client" | "pay-provider";
}

export interface BookingListItemBase {
  id: string;
  /** UTC epoch seconds -- `null` only for a pre-3.4 booking with no slot. */
  slotStartsAt: number | null;
  deposit: Money;
  balance: Money;
  price: Money;
  escrowState: "locked" | "released" | "refunded" | null;
  lifecycle: BookingLifecycle;
  balanceState: BalanceState;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  contractId: string | null;
  /** UTC epoch seconds. */
  holdExpiresAt: number | null;
  /** The AD-13 hold's own window has passed with no chain evidence at all --
   * shown under a separate, collapsed "Expired holds" group, never mixed
   * into the main list (the spec's own "Always" rule). */
  isExpiredHold: boolean;
}

export interface ClientBookingListItem extends BookingListItemBase {
  provider: BookingProviderSummary;
}

export interface ProviderBookingListItem extends BookingListItemBase {
  /** Full wallet address -- shortened only at render time (`lib/stellar.ts`'s
   * `shortenStellarId`, the same helper `EscrowProof` already uses). */
  clientWalletAddress: string;
}

export interface MyBookingsResponse {
  bookings: ClientBookingListItem[];
}

export interface ProviderBookingsResponse {
  bookings: ProviderBookingListItem[];
}
