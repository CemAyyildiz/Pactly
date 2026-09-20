/** TanStack Query hooks over `client.ts` -- the only place a page reaches
 * for provider/category data. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost, apiPut, ApiError } from "./client";
import type {
  ActionResponse,
  AdminDisputesResponse,
  BalancePaymentBuildResponse,
  BalancePaymentSubmitResponse,
  BookingView,
  CategoriesResponse,
  DiscoverFiltersParams,
  DisputeOutcome,
  DisputeReason,
  FundResponse,
  HoldSlotResponse,
  LockResponse,
  MyBookingsResponse,
  OpenDisputeResponse,
  ProviderBookingsResponse,
  ProviderProfile,
  ProvidersResponse,
  QuoteResponse,
  ResolveDisputeResponse,
  SubmitResponse,
  SuggestResponse,
  AnchorChallengeResponse,
  LocalDepositView,
  OpenLocalDepositResponse,
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

/** Story 2.2: `GET /quote`'s indicative local-currency equivalent for a
 * USDC smallest-unit `amount` -- one query per distinct amount, so the
 * deposit, balance and total on the payment step each get their own quote.
 * A quote failure never blocks the flow (this story's own "Always" rule),
 * so this never retries past the backend's own 60s cache window and the
 * caller renders its own plain-sentence fallback on `isError`. */
export function useQuote(amount: string | undefined) {
  return useQuery({
    queryKey: ["quote", amount],
    queryFn: () => apiGet<QuoteResponse>(`/quote?amount=${amount}`),
    enabled: Boolean(amount),
    retry: false,
    staleTime: 60_000,
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

// ---------------------------------------------------------------------------
// Story 3.4: the client booking flow. `BookingPage.tsx` drives lock/fund/
// submit imperatively (each step waits on a wallet signature before the
// next call is even built), so those three are plain async functions, not
// mutations -- only the hold and the polling read need TanStack Query's own
// caching/retry behavior.
// ---------------------------------------------------------------------------

export interface HoldSlotInput {
  providerId: string;
  slotStartsAt: number;
  tzOffsetMinutes?: number;
}

/**
 * Review follow-up: `mutateAsync` takes the token as part of its own call
 * arguments now, rather than closing over whatever `session` this hook was
 * *rendered* with. `BookingPage.tsx`'s first-time sign-in flow calls
 * `signIn()`, then immediately holds the slot in the very same function --
 * `setSession(activeSession)` only takes effect on the *next* render, so a
 * `useHoldSlot(session)`-style hook would still capture the old (absent)
 * session in its `mutationFn` closure for that same call. Passing the
 * fresh token explicitly avoids relying on a render that has not happened
 * yet.
 */
export function useHoldSlot() {
  return useMutation({
    mutationFn: ({ token, ...input }: HoldSlotInput & { token: string }) => apiPost<HoldSlotResponse>("/bookings/hold", input, token),
  });
}

export function lockDeposit(bookingId: string, session: Session, rebuild = false): Promise<LockResponse> {
  return apiPost<LockResponse>(`/bookings/${bookingId}/lock`, rebuild ? { rebuild: true } : {}, session.token);
}

export function fundDeposit(bookingId: string, session: Session): Promise<FundResponse> {
  return apiPost<FundResponse>(`/bookings/${bookingId}/fund`, {}, session.token);
}

export function submitSignedTransaction(bookingId: string, signedXdr: string, session: Session): Promise<SubmitResponse> {
  return apiPost<SubmitResponse>(`/bookings/${bookingId}/submit`, { signedXdr }, session.token);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fundDeposit`, retried a few times -- the Design Notes' own documented
 * alternative to polling for "the deploy is visible": Trustless Work's
 * build-fund step can only succeed once the just-submitted deploy
 * transaction has actually landed on Soroban (a few seconds after
 * submission, not instant), and nothing in the read API surfaces a
 * finer-grained "deployed but not yet funded" signal (the reconciler's own
 * lifecycle only ever starts at "funded").
 *
 * Review follow-up on the retry policy itself: `ESCROW_UNAVAILABLE` (a
 * transient Trustless Work outage) is always retried. `ESCROW_REJECTED`
 * (a real refusal) is only retried within the first 30 seconds after the
 * deploy was submitted -- the window where "the contract doesn't exist
 * yet" is the most likely explanation; past that, continuing to retry
 * would just mask a genuine, permanent refusal as a slow success. Any
 * other failure (`BOOKING_STATE`, a network drop, `401`) is rethrown
 * immediately, unretried.
 */
export async function fundDepositWithRetry(
  bookingId: string,
  session: Session,
  deploySubmittedAtMs: number,
  attempts = 5,
  delayMs = 2500,
): Promise<FundResponse> {
  const REJECTED_RETRY_WINDOW_MS = 30_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fundDeposit(bookingId, session);
    } catch (error) {
      const withinRejectedWindow = Date.now() - deploySubmittedAtMs < REJECTED_RETRY_WINDOW_MS;
      const retryable =
        error instanceof ApiError && (error.code === "ESCROW_UNAVAILABLE" || (error.code === "ESCROW_REJECTED" && withinRejectedWindow));
      if (!retryable || attempt === attempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
  // Unreachable -- the loop above always returns or throws.
  throw new Error("fundDepositWithRetry: exhausted attempts without returning or throwing");
}

/** `GET /bookings/:id`, polled while the booking hasn't reached a terminal
 * `escrowState` yet -- the one place the UI learns "locked" actually
 * happened (never from a submit response, per the spec's own "Always"
 * rule). `refetchInterval` stays a short constant rather than a prop:
 * every caller of this hook wants the same "poll until reconciled"
 * behavior. */
const BOOKING_POLL_INTERVAL_MS = 2000;

export function useBooking(bookingId: string | undefined, session: Session | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["bookings", bookingId],
    queryFn: () => apiGet<BookingView>(`/bookings/${bookingId}`, session?.token),
    enabled: Boolean(bookingId && session) && (options.enabled ?? true),
    retry: false,
    // Review follow-up: stop polling once a terminal `escrowState` is seen
    // (unchanged) *and* once the last attempt errored (a 401, a dropped
    // connection, ...) -- `retry: false` only skips retrying that one
    // failed fetch, it does not stop `refetchInterval` from trying again
    // on schedule regardless of the last outcome.
    refetchInterval: (query) => (query.state.data?.escrowState || query.state.error ? false : BOOKING_POLL_INTERVAL_MS),
  });
}

// ---------------------------------------------------------------------------
// Story 3.5: the two-sided status panel. No actions live here yet (Stories
// 3.6/3.7), so both lists are plain queries -- no mutation, no
// `queryClient.setQueryData` to keep in sync with anything.
// ---------------------------------------------------------------------------

/** `GET /me/bookings` -- "My bookings": every booking the signed-in wallet
 * is the client on, across every provider. */
export function useMyBookings(session: Session | undefined) {
  return useQuery({
    queryKey: ["me", "bookings", session?.walletAddress],
    queryFn: () => apiGet<MyBookingsResponse>("/me/bookings", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

/** `GET /me/provider/bookings` -- the provider panel's "Bookings" view. */
export function useProviderBookings(session: Session | undefined) {
  return useQuery({
    queryKey: ["me", "provider", "bookings", session?.walletAddress],
    queryFn: () => apiGet<ProviderBookingsResponse>("/me/provider/bookings", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Story 3.6: appointment completion, release and resolution. Each action
// builds an unsigned XDR the caller still has to sign and submit (3.4's own
// `signXdr` + `submitSignedTransaction` pair) -- these stay plain async
// functions, the same reasoning `lockDeposit`/`fundDeposit` above already
// follow: the caller drives a multi-step flow (build -> sign -> submit),
// which a single `useMutation` cannot express as cleanly as an imperative
// call `BookingCard.tsx` awaits step by step.
// ---------------------------------------------------------------------------

export function completeAppointment(bookingId: string, session: Session): Promise<ActionResponse> {
  return apiPost<ActionResponse>(`/bookings/${bookingId}/complete`, {}, session.token);
}

export function approveAppointment(bookingId: string, session: Session): Promise<ActionResponse> {
  return apiPost<ActionResponse>(`/bookings/${bookingId}/approve`, {}, session.token);
}

export function releaseDeposit(bookingId: string, session: Session): Promise<ActionResponse> {
  return apiPost<ActionResponse>(`/bookings/${bookingId}/release`, {}, session.token);
}

/** Builds the unsigned start-dispute XDR and, in the same response, the
 * booking policy's own suggested outcome -- the caller shows that sentence
 * *before* ever asking for a signature (EXPERIENCE.md: "Cancelling and
 * resolution" -- policy guidance stated first, chain state kept separate).
 * Building this XDR has no on-chain effect by itself; nothing moves unless
 * the caller goes on to sign and submit it. */
export function openDispute(bookingId: string, reason: DisputeReason, session: Session): Promise<OpenDisputeResponse> {
  return apiPost<OpenDisputeResponse>(`/bookings/${bookingId}/dispute`, { reason }, session.token);
}

/** Pactly's own dispute-resolver signature -- only ever callable by the
 * admin wallet that is also `TRUSTLESS_WORK_PLATFORM_ADDRESS` (the backend
 * enforces this; `ResolutionsPage.tsx` just calls it and shows whatever
 * comes back, including a `403 NOT_DISPUTE_RESOLVER`). */
export function resolveDispute(bookingId: string, outcome: DisputeOutcome, session: Session): Promise<ResolveDisputeResponse> {
  return apiPost<ResolveDisputeResponse>(`/admin/bookings/${bookingId}/resolve`, { outcome }, session.token);
}

/** `GET /admin/disputes` -- the admin "Resolutions" list. No retry: a
 * `404 NOT_ADMIN` will not become true by retrying the same wallet. */
export function useAdminDisputes(session: Session | undefined) {
  return useQuery({
    queryKey: ["admin", "disputes", session?.walletAddress],
    queryFn: () => apiGet<AdminDisputesResponse>("/admin/disputes", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Story 3.7: paying the balance before the session. Two independent paths
// (AD-3: neither ever touches escrow) -- `buildBalancePayment`/
// `submitBalancePayment` are the client's own build -> sign -> submit pair
// (same imperative-function shape as `lockDeposit`/`fundDeposit`/
// `submitSignedTransaction` above, for the same reason: the caller drives a
// multi-step flow no single `useMutation` expresses as cleanly);
// `markBalancePaidCash` is the provider's own one-step record.
// ---------------------------------------------------------------------------

export function buildBalancePayment(bookingId: string, session: Session): Promise<BalancePaymentBuildResponse> {
  return apiPost<BalancePaymentBuildResponse>(`/bookings/${bookingId}/balance/pay`, {}, session.token);
}

export function submitBalancePayment(bookingId: string, signedXdr: string, session: Session): Promise<BalancePaymentSubmitResponse> {
  return apiPost<BalancePaymentSubmitResponse>(`/bookings/${bookingId}/balance/submit`, { signedXdr }, session.token);
}

export function markBalancePaidCash(bookingId: string, session: Session): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>(`/bookings/${bookingId}/balance/mark-cash`, {}, session.token);
}

// ---------------------------------------------------------------------------
// Story 2.4: local-currency deposit. Imperative like lock/fund -- each
// step waits on a wallet signature, so these are plain async functions.
// ---------------------------------------------------------------------------

export function requestAnchorChallenge(bookingId: string, session: Session): Promise<AnchorChallengeResponse> {
  return apiPost<AnchorChallengeResponse>(`/bookings/${bookingId}/anchor/challenge`, {}, session.token);
}

export function verifyAnchorChallenge(bookingId: string, signedXdr: string, session: Session): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>(`/bookings/${bookingId}/anchor/verify`, { signedXdr }, session.token);
}

export function openLocalDeposit(bookingId: string, session: Session): Promise<OpenLocalDepositResponse> {
  return apiPost<OpenLocalDepositResponse>(`/bookings/${bookingId}/deposit/local`, {}, session.token);
}

export function submitLocalDepositTrustline(bookingId: string, signedXdr: string, session: Session): Promise<OpenLocalDepositResponse> {
  return apiPost<OpenLocalDepositResponse>(`/bookings/${bookingId}/deposit/local/trustline`, { signedXdr }, session.token);
}

export function getLocalDeposit(bookingId: string, session: Session): Promise<LocalDepositView> {
  return apiGet<LocalDepositView>(`/bookings/${bookingId}/deposit/local`, session.token);
}

export function simulateLocalDeposit(bookingId: string, session: Session): Promise<LocalDepositView> {
  return apiPost<LocalDepositView>(`/bookings/${bookingId}/deposit/local/simulate`, {}, session.token);
}
