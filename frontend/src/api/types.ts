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
}

export interface LockResponse {
  unsignedXdr: string;
  contractId: string;
}

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
