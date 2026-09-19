/** TanStack Query hooks over `client.ts` -- the only place a page reaches
 * for provider/category data. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPut } from "./client";
import type {
  CategoriesResponse,
  DiscoverFiltersParams,
  ProviderProfile,
  ProvidersResponse,
  SuggestResponse,
} from "./types";
import type { Session } from "../wallet";

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => apiGet<CategoriesResponse>("/categories"),
  });
}

export interface UseDiscoverProvidersOptions {
  /** Defaults to `true`. `DiscoverPage` sets this `false` while a
   * `?category=` slug in the URL has not yet been checked against the
   * loaded category list -- firing this query too early would fetch (and
   * briefly show) the unfiltered list before the real filter is known. */
  enabled?: boolean;
}

/** Builds `GET /providers`'s query string from every Story 3.2/3.3 filter
 * -- the one place a `DiscoverFiltersParams` becomes a URL, so
 * `useDiscoverProviders`'s query key and its actual request can never
 * drift apart. `format` is repeated (`?format=a&format=b`), matching the
 * backend's own `c.req.queries("format")` read. */
function buildProvidersPath(filters: DiscoverFiltersParams): string {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.q) params.set("q", filters.q);
  for (const format of filters.formats ?? []) {
    params.append("format", format);
  }
  if (filters.minPrice !== undefined) params.set("minPrice", filters.minPrice);
  if (filters.maxPrice !== undefined) params.set("maxPrice", filters.maxPrice);
  if (filters.maxDepositBps !== undefined) params.set("maxDepositBps", String(filters.maxDepositBps));
  if (filters.when) params.set("when", filters.when);
  const query = params.toString();
  return query ? `/providers?${query}` : "/providers";
}

/** `GET /providers[?category=&q=&format=&minPrice=&maxPrice=&maxDepositBps=&when=]`
 * -- the Discover list, no auth, no retry (an unknown category will not
 * become known by retrying; a genuine network failure is handled by the
 * page's own error state, not a silent background retry that would delay
 * it). */
export function useDiscoverProviders(filters: DiscoverFiltersParams, options: UseDiscoverProvidersOptions = {}) {
  return useQuery({
    queryKey: ["providers", filters],
    queryFn: () => apiGet<ProvidersResponse>(buildProvidersPath(filters)),
    enabled: options.enabled ?? true,
    retry: false,
  });
}

/** `GET /providers/suggest?q=` -- Story 3.3's autocomplete. No auth, no
 * retry; disabled below the backend's own two-character minimum so a
 * one-character query never fires a request that would only come back
 * empty anyway. */
export function useProviderSuggestions(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["providers", "suggest", trimmed],
    queryFn: () => apiGet<SuggestResponse>(`/providers/suggest?q=${encodeURIComponent(trimmed)}`),
    enabled: trimmed.length >= 2,
    retry: false,
  });
}

/** The public `GET /providers/:id` view -- no auth, no retry on a 404
 * (an unapproved/unknown id will not become approved by retrying). */
export function usePublicProviderProfile(id: string | undefined) {
  return useQuery({
    queryKey: ["providers", id],
    queryFn: () => apiGet<ProviderProfile>(`/providers/${id}`),
    enabled: Boolean(id),
    retry: false,
  });
}

const OWN_PROVIDER_KEY = (walletAddress: string | undefined) => ["me", "provider", walletAddress] as const;

/** `GET /me/provider` -- the signed-in provider's own view, including
 * while unapproved. */
export function useOwnProviderProfile(session: Session | undefined) {
  return useQuery({
    queryKey: OWN_PROVIDER_KEY(session?.walletAddress),
    queryFn: () => apiGet<ProviderProfile>("/me/provider", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

export interface ProviderRulesInput {
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
}

export function useUpdateProviderRules(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderRulesInput) => apiPut<ProviderProfile>("/me/provider/rules", input, session?.token),
    onSuccess: (profile) => {
      queryClient.setQueryData(OWN_PROVIDER_KEY(session?.walletAddress), profile);
    },
  });
}

export function useUpdateProviderAvailability(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slots: number[]) => apiPut<ProviderProfile>("/me/provider/availability", { slots }, session?.token),
    onSuccess: (profile) => {
      queryClient.setQueryData(OWN_PROVIDER_KEY(session?.walletAddress), profile);
    },
  });
}
