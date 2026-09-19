/** TanStack Query hooks over `client.ts` -- the only place a page reaches
 * for provider/category data. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPut } from "./client";
import type { CategoriesResponse, ProviderProfile, ProvidersResponse } from "./types";
import type { Session } from "../wallet";

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => apiGet<CategoriesResponse>("/categories"),
  });
}

/** `GET /providers[?category=<slug>]` -- the Discover list, no auth, no
 * retry (an unknown slug will not become known by retrying; a genuine
 * network failure is handled by the page's own error state, not a silent
 * background retry that would delay it). */
export function useDiscoverProviders(categorySlug: string | undefined) {
  return useQuery({
    queryKey: ["providers", categorySlug ?? null],
    queryFn: () =>
      apiGet<ProvidersResponse>(categorySlug ? `/providers?category=${encodeURIComponent(categorySlug)}` : "/providers"),
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
