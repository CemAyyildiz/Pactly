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
