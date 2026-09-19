/**
 * Builds the Hono app: route registration plus the one identity-extraction
 * middleware this story adds. Kept separate from `index.ts`'s `serve(...)`
 * call (the only thing `index.ts` still does) purely for testability --
 * `serve` opens a real TCP listener as an import-time side effect, which a
 * unit test exercising a route or `requirePactlyAuth` must never trigger;
 * `app.test.ts` drives this app directly via Hono's own `app.request(...)`,
 * with every network seam beneath it (the anchor's `fetch`, this process's
 * clock) injected, never reaching `tr-mock-anchor.fly.dev`. `index.ts`'s own
 * black-box startup test (`db.test.ts`) is unaffected: it still spawns the
 * real process and hits `/health` over the real port.
 */
import { Hono } from "hono";
import type { Context, Next } from "hono";

import {
  buildPactlyChallenge,
  issuePactlyJwt,
  verifyPactlyChallenge,
  verifyPactlyJwt,
} from "./auth/challenge.js";
import {
  PactlyChallengeExpiredError,
  PactlyChallengeInvalidError,
  PactlyChallengeReplayedError,
  PactlyInvalidAccountError,
  PactlyJwtError,
} from "./auth/errors.js";
import type { Db } from "./db/client.js";
import {
  InvalidAvailabilitySlotsError,
  InvalidProviderRulesError,
  NotAProviderError,
  ProviderNotFoundError,
  getOwnProviderProfile,
  getPublicProviderProfile,
  listCategoriesWithProviderCounts,
  listDiscoverProviders,
  suggestDiscoverQueries,
  updateProviderAvailability,
  updateProviderRules,
  type DiscoverFilters,
} from "./services/profile.js";
import {
  BookingActionPendingError,
  BookingEscrowStateError,
  BookingHoldExpiredError,
  BookingNotFoundError,
  InvalidDisputeReasonError,
  NothingToPayError,
  SlotTakenError,
  SlotUnavailableError,
  TooManyHoldsError,
  XdrMismatchError,
  approveAppointment,
  buildBalancePayment,
  completeAppointment,
  fundDeposit,
  getBookingForClient,
  getBookingView,
  holdSlot,
  listBookingsForClient,
  listBookingsForProvider,
  listOpenDisputes,
  lockDeposit,
  markBalancePaidCash,
  openDispute,
  releaseDeposit,
  resolveBookingDispute,
  resolveSubmitRole,
  submitBalancePayment,
  submitSignedTransaction,
  type BuildBalancePaymentDeps,
} from "./services/booking.js";
import { EscrowApiError, EscrowConfigError, EscrowRequestError } from "./escrow/trustless-work/errors.js";
import { defaultEscrowAdapter } from "./escrow/trustless-work/client.js";
import type { EscrowAdapter } from "./escrow/interface.js";
import { PaymentFailedError, PaymentUnavailableError } from "./payments/errors.js";
import type { SubmitPaymentDeps } from "./payments/stellar.js";
import { config } from "./config.js";
import { DISPUTE_OUTCOMES, type DisputeOutcome, type DisputeReason } from "./db/schema.js";
import { getBookingById } from "./db/bookings.js";

export interface Variables {
  /** Set by `requirePactlyAuth` once a request's Pactly JWT verifies --
   * "which wallet is this," never "is this wallet allowed to." AD-12's
   * role-based authorization (admin/provider) is a later story's job, not
   * this one's -- see this story's own Design Notes. */
  walletAddress: string;
}

export type App = Hono<{ Variables: Variables }>;

/** Extracts *which wallet* is calling from a verified Pactly JWT. A
 * missing, expired or tampered token is rejected the same way, with a
 * meaningful JSON error, never a stack trace (this story's own Acceptance
 * Criteria). */
const BEARER_PREFIX = /^bearer\s+/i;

export async function requirePactlyAuth(c: Context<{ Variables: Variables }>, next: Next) {
  const header = c.req.header("Authorization");
  // Case-insensitive per RFC 7235's auth-scheme grammar -- "bearer <token>"
  // is just as valid as "Bearer <token>".
  const token = header && BEARER_PREFIX.test(header) ? header.replace(BEARER_PREFIX, "") : undefined;
  if (!token) {
    return c.json({ code: "unauthorized", message: "Sign in required." }, 401);
  }
  try {
    const { walletAddress } = await verifyPactlyJwt(token);
    c.set("walletAddress", walletAddress);
  } catch (error) {
    if (error instanceof PactlyJwtError) {
      return c.json({ code: "unauthorized", message: "Sign in required." }, 401);
    }
    throw error;
  }
  await next();
}

/**
 * Story 3.6: gates every `/admin/...` route to a wallet in
 * `config.adminWallets` (AD-12) -- a non-admin caller gets the same
 * `404 NOT_ADMIN` every other "you don't own this" check in this file gives
 * (never a `403`, so an admin-only route's very existence is not
 * distinguishable from an unknown one). Runs after {@link requirePactlyAuth}
 * (which is what sets `walletAddress`), never before. Being *an* admin is
 * distinct from being *the* dispute resolver (`config
 * .trustlessWorkPlatformAddress`) -- the resolve route's own extra check,
 * not this middleware's.
 */
async function requireAdmin(c: Context<{ Variables: Variables }>, next: Next) {
  if (!config.adminWallets.includes(c.get("walletAddress"))) {
    return c.json({ code: "NOT_ADMIN", message: "This wallet is not a Pactly admin." }, 404);
  }
  await next();
}

/** Non-negative integer string -- Story 3.3's own `minPrice`/`maxPrice`
 * shape (AD-7's smallest-unit integer strings, with `"0"` also allowed
 * since a free session is a valid lower bound). */
const NON_NEGATIVE_INTEGER_STRING = /^(0|[1-9]\d*)$/;
const MIN_DEPOSIT_RATE_BPS_FILTER = 1;
const MAX_DEPOSIT_RATE_BPS_FILTER = 10000;
const AVAILABILITY_FILTER_VALUES = new Set(["24h", "week"]);

/** Story 3.3: turns `GET /providers`'s query string into a
 * {@link DiscoverFilters}, dropping every invalid or unknown value rather
 * than erroring (the spec's own "Always" rule: "Unknown or invalid params
 * are ignored, never an error" -- and the I/O matrix's own per-row
 * behaviour for each of these). `category` is parsed by the caller, not
 * here, since it is resolved against the category table, not validated by
 * shape. */
function parseDiscoverFilters(c: Context<{ Variables: Variables }>): DiscoverFilters {
  const filters: DiscoverFilters = {};

  const q = c.req.query("q");
  if (q !== undefined && q.trim().length > 0) {
    filters.query = q.trim();
  }

  const formats = c.req.queries("format");
  if (formats && formats.length > 0) {
    filters.formats = formats;
  }

  const minPrice = c.req.query("minPrice");
  if (minPrice !== undefined && NON_NEGATIVE_INTEGER_STRING.test(minPrice)) {
    filters.minPriceAmount = minPrice;
  }
  const maxPrice = c.req.query("maxPrice");
  if (maxPrice !== undefined && NON_NEGATIVE_INTEGER_STRING.test(maxPrice)) {
    filters.maxPriceAmount = maxPrice;
  }

  const maxDepositBps = c.req.query("maxDepositBps");
  if (maxDepositBps !== undefined && /^\d+$/.test(maxDepositBps)) {
    const parsed = Number(maxDepositBps);
    if (parsed >= MIN_DEPOSIT_RATE_BPS_FILTER && parsed <= MAX_DEPOSIT_RATE_BPS_FILTER) {
      filters.maxDepositRateBps = parsed;
    }
  }

  const when = c.req.query("when");
  if (when !== undefined && AVAILABILITY_FILTER_VALUES.has(when)) {
    filters.availability = when as "24h" | "week";
  }

  return filters;
}

export interface CreateAppOptions {
  /** Overrides the escrow adapter every booking route uses -- defaults to
   * the real Trustless-Work-backed one. A test can inject a fake adapter
   * to exercise `502 ESCROW_REJECTED`/accepted-deploy paths without a real
   * Trustless Work API key. */
  escrowAdapter?: EscrowAdapter;
  /** Story 3.7: overrides `POST /bookings/:id/balance/pay`'s own network
   * seams (how the client's account is loaded, how the USDC asset is
   * resolved) -- same "inject the network access" discipline as
   * `escrowAdapter` above, so a test never needs a real Soroban RPC
   * endpoint or a real anchor `stellar.toml` to exercise this route. */
  buildBalancePaymentDeps?: BuildBalancePaymentDeps;
  /** Story 3.7: overrides `POST /bookings/:id/balance/submit`'s own
   * send/poll seam -- lets a test exercise `502 PAYMENT_FAILED`/
   * `503 PAYMENT_UNAVAILABLE` without a real RPC endpoint. */
  submitBalancePaymentDeps?: SubmitPaymentDeps;
}

export function createApp(db: Db, options: CreateAppOptions = {}): App {
  const app: App = new Hono<{ Variables: Variables }>();
  const escrowAdapter = options.escrowAdapter ?? defaultEscrowAdapter;
  const buildBalancePaymentDeps = options.buildBalancePaymentDeps ?? {};
  const submitBalancePaymentDeps = options.submitBalancePaymentDeps ?? {};

  // Every route above handles its own typed failures and returns the
  // `{code, message}` envelope itself; this is only the backstop for a
  // failure none of them anticipated -- still the same envelope, never
  // Hono's own default plain-text 500.
  app.onError((error, c) => {
    console.error("[app] unhandled error", error);
    return c.json({ code: "internal_error", message: "Something went wrong. Please try again." }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  /** Pactly's own login, step one: a wallet asks for a challenge to sign. */
  app.post("/auth/challenge", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const publicKey = typeof body?.publicKey === "string" ? body.publicKey : undefined;
    if (!publicKey) {
      return c.json({ code: "invalid_request", message: "publicKey is required." }, 400);
    }
    try {
      const transaction = buildPactlyChallenge(publicKey);
      return c.json({ transaction });
    } catch (error) {
      if (error instanceof PactlyInvalidAccountError) {
        return c.json({ code: "invalid_account", message: error.message }, 400);
      }
      throw error;
    }
  });

  /** Pactly's own login, step two: the wallet's signed challenge comes back
   * and, if it checks out, a Pactly JWT is issued -- the platform's whole
   * login mechanism, no passwords, ever (FR10). The anchor's JWT never
   * enters this handler at all, let alone this response (AD-5). */
  app.post("/auth/verify", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const transaction = typeof body?.transaction === "string" ? body.transaction : undefined;
    if (!transaction) {
      return c.json({ code: "invalid_request", message: "transaction is required." }, 400);
    }
    try {
      const { walletAddress } = await verifyPactlyChallenge(db, transaction);
      const token = await issuePactlyJwt(walletAddress);
      return c.json({ token, walletAddress });
    } catch (error) {
      if (error instanceof PactlyChallengeExpiredError) {
        return c.json({ code: "challenge_expired", message: error.message }, 401);
      }
      if (error instanceof PactlyChallengeReplayedError) {
        return c.json({ code: "challenge_replayed", message: error.message }, 401);
      }
      if (error instanceof PactlyChallengeInvalidError) {
        return c.json({ code: "challenge_invalid", message: error.message }, 401);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.1: provider profile and availability. Public reads need no
  // auth (`/categories`, `/providers/:id`); provider writes go through
  // `requirePactlyAuth` and resolve "which profile" from the caller's
  // wallet, never from a body/query id -- there is nothing for a caller to
  // lie about (same shape as `auth/challenge.ts`'s own comment on this).
  // ---------------------------------------------------------------------

  /** Story 3.2: `providerCount` per category, approved providers only
   * (AC1). */
  app.get("/categories", async (c) => {
    const categories = await listCategoriesWithProviderCounts(db);
    return c.json({ categories });
  });

  /** Story 3.2/3.3: the Discover list. Approved providers only (enforced
   * in `listApprovedProviderProfilesForDiscover`, never by filtering
   * here) as card objects, soonest-open-slot first. `?category=<slug>`
   * filters to that category; an unknown slug is a `200` with an empty
   * list, never an error (the spec's own "Unknown slug" row) -- there is
   * nothing here for the route to catch. Story 3.3 adds `q`, `format`,
   * `minPrice`/`maxPrice`, `maxDepositBps` and `when`, every one of them
   * optional and silently dropped when invalid (`parseDiscoverFilters`). */
  app.get("/providers", async (c) => {
    const category = c.req.query("category");
    const filters = parseDiscoverFilters(c);
    const providers = await listDiscoverProviders(db, category, filters);
    return c.json({ providers });
  });

  /** Story 3.3: search suggestions. Registered before `/providers/:id` so
   * `suggest` is never captured as an `:id` (the spec's own Code Map
   * note). `q` shorter than two characters is an empty list, never an
   * error. */
  app.get("/providers/suggest", async (c) => {
    const q = c.req.query("q") ?? "";
    const suggestions = await suggestDiscoverQueries(db, q);
    return c.json({ suggestions });
  });

  /** Approved profiles only; an unapproved or unknown id gives the same
   * 404 either way so nothing about an unapproved profile leaks. */
  app.get("/providers/:id", async (c) => {
    try {
      const profile = await getPublicProviderProfile(db, c.req.param("id"));
      return c.json(profile);
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return c.json({ code: "PROVIDER_NOT_FOUND", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.get("/me/provider", requirePactlyAuth, async (c) => {
    try {
      const profile = await getOwnProviderProfile(db, c.get("walletAddress"));
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.put("/me/provider/rules", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    try {
      const profile = await updateProviderRules(db, c.get("walletAddress"), {
        priceAmount: typeof body?.priceAmount === "string" ? body.priceAmount : "",
        depositRateBps: typeof body?.depositRateBps === "number" ? body.depositRateBps : Number.NaN,
        cancellationWindowHours:
          typeof body?.cancellationWindowHours === "number" ? body.cancellationWindowHours : Number.NaN,
      });
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      if (error instanceof InvalidProviderRulesError) {
        return c.json({ code: "INVALID_RULES", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  app.put("/me/provider/availability", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const slots: unknown = body?.slots;
    if (!Array.isArray(slots)) {
      return c.json(
        { code: "INVALID_SLOTS", message: "slots must be an array of epoch seconds.", details: { slots: "required" } },
        400,
      );
    }
    try {
      const profile = await updateProviderAvailability(db, c.get("walletAddress"), slots);
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      if (error instanceof InvalidAvailabilitySlotsError) {
        return c.json({ code: "INVALID_SLOTS", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.4: the client booking flow ("Lock with Pactly"). Every route
  // below requires a Pactly JWT; `lock`/`fund`/`submit`/`GET` all resolve
  // ownership from the caller's own wallet, never from a body/query field
  // (same discipline as the Story 3.1 routes above) -- an unknown booking
  // and someone else's booking give the identical `404 BOOKING_NOT_FOUND`,
  // so bookings are never enumerable.
  // ---------------------------------------------------------------------

  /** A Trustless Work failure translated into the route's own envelope --
   * shared by lock/fund/submit, the three routes that can reach the
   * adapter. Never a raw body or stack trace (AC5, carried through from
   * Story 2.6). */
  function escrowErrorResponse(error: EscrowApiError | EscrowRequestError | EscrowConfigError) {
    if (error instanceof EscrowApiError) {
      return { code: "ESCROW_REJECTED", message: "Trustless Work could not process this request.", status: 502 as const };
    }
    return { code: "ESCROW_UNAVAILABLE", message: "Trustless Work is unavailable right now. Your deposit is untouched.", status: 503 as const };
  }

  app.post("/bookings/hold", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const providerId = typeof body?.providerId === "string" ? body.providerId : undefined;
    const slotStartsAt = typeof body?.slotStartsAt === "number" ? body.slotStartsAt : undefined;
    const tzOffsetMinutes = typeof body?.tzOffsetMinutes === "number" ? body.tzOffsetMinutes : undefined;
    if (!providerId || slotStartsAt === undefined) {
      return c.json(
        { code: "invalid_request", message: "providerId and slotStartsAt are required." },
        400,
      );
    }
    if (!Number.isInteger(slotStartsAt)) {
      return c.json({ code: "invalid_request", message: "slotStartsAt must be an integer number of epoch seconds." }, 400);
    }
    try {
      const result = await holdSlot(db, {
        providerProfileId: providerId,
        clientWalletAddress: c.get("walletAddress"),
        slotStartsAt,
        tzOffsetMinutes,
      });
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return c.json({ code: "PROVIDER_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof SlotUnavailableError) {
        return c.json({ code: "SLOT_UNAVAILABLE", message: error.message }, 409);
      }
      if (error instanceof TooManyHoldsError) {
        return c.json({ code: "TOO_MANY_HOLDS", message: error.message }, 429);
      }
      if (error instanceof SlotTakenError) {
        return c.json(
          { code: "SLOT_TAKEN", message: error.message, details: { sameDaySlots: error.sameDaySlots } },
          409,
        );
      }
      throw error;
    }
  });

  app.post("/bookings/:id/lock", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await getBookingForClient(db, bookingId, c.get("walletAddress"));
      const body = await c.req.json().catch(() => undefined);
      const rebuild = body?.rebuild === true;
      const result = await lockDeposit(db, bookingId, escrowAdapter, { rebuild });
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingHoldExpiredError) {
        return c.json({ code: "HOLD_EXPIRED", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/fund", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await getBookingForClient(db, bookingId, c.get("walletAddress"));
      const result = await fundDeposit(db, bookingId, escrowAdapter);
      return c.json({ unsignedXdr: result.unsignedXdr });
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingHoldExpiredError) {
        return c.json({ code: "HOLD_EXPIRED", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** Story 3.6 (review round): role-aware -- a client, a provider, or
   * Pactly's own resolver wallet may all submit here, each only ever
   * relaying the transaction kind {@link resolveSubmitRole}'s own role
   * grants it (`services/booking.ts`'s `isKindAllowedForRole`). A wallet
   * holding none of the three roles on this booking gets the same
   * `404 BOOKING_NOT_FOUND` every other route gives (bookings are never
   * enumerable). Submit is allowed after the hold expires (the spec's own
   * "Never" rule) -- role resolution only ever checks existence and
   * ownership, never the hold's own clock. */
  app.post("/bookings/:id/submit", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      // Review follow-up: role resolution now runs *before* the body is
      // even parsed for its own shape -- a stranger's request gets the
      // identical 404 BOOKING_NOT_FOUND every other route gives them,
      // never a 400 that would first confirm the booking exists.
      const { role } = await resolveSubmitRole(db, bookingId, c.get("walletAddress"));
      const body = await c.req.json().catch(() => undefined);
      const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : undefined;
      if (!signedXdr) {
        return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
      }
      const result = await submitSignedTransaction(db, bookingId, signedXdr, role, escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof XdrMismatchError) {
        return c.json({ code: "XDR_MISMATCH", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  app.get("/bookings/:id", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const view = await getBookingView(db, bookingId, c.get("walletAddress"));
      return c.json(view);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.5: the two-sided status panel. Both routes resolve "whose
  // bookings" from the caller's own wallet alone (same discipline as every
  // other `/me/...` route in this file) -- there is no id in either URL for
  // a caller to substitute someone else's for.
  // ---------------------------------------------------------------------

  /** "My bookings": every booking the caller's own wallet is the client on,
   * across every provider, ordered by appointment date (AC2). An empty
   * list is a plain `200` with `bookings: []` -- the "No bookings yet."
   * empty state is the frontend's own job, not an error case here. */
  app.get("/me/bookings", requirePactlyAuth, async (c) => {
    const bookingsList = await listBookingsForClient(db, c.get("walletAddress"));
    return c.json({ bookings: bookingsList });
  });

  /** The provider panel's "Bookings" view: every booking against the
   * caller's own provider profile, ordered by appointment date. A wallet
   * with no provider profile gets the same `404 NOT_A_PROVIDER` every other
   * `/me/provider` route already gives. */
  app.get("/me/provider/bookings", requirePactlyAuth, async (c) => {
    try {
      const bookingsList = await listBookingsForProvider(db, c.get("walletAddress"));
      return c.json({ bookings: bookingsList });
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.6: appointment completion, release and resolution. Every
  // action route shares the deploy/fund routes' own discipline: ownership
  // (or, for `/admin/...`, admin-wallet membership) resolves to a
  // `404`/`NOT_ADMIN` before anything else, a wrong lifecycle state is a
  // `409 BOOKING_STATE`, and a Trustless Work failure maps through the same
  // `escrowErrorResponse` helper Story 3.4 already defined above.
  // ---------------------------------------------------------------------

  app.post("/bookings/:id/complete", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await completeAppointment(db, bookingId, c.get("walletAddress"), escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/approve", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await approveAppointment(db, bookingId, c.get("walletAddress"), escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/release", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await releaseDeposit(db, bookingId, c.get("walletAddress"), escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** Either side (client or provider) may open a dispute -- `reason` is
   * validated here, against the schema's own {@link DISPUTE_REASONS}, so an
   * unknown value never reaches the service layer at all (the spec's own
   * "unknown reason: 400" row). */
  /** Either side (client or provider) may open a dispute -- `reason` is
   * validated inside `openDispute` against the caller's own role-scoped
   * whitelist (Story 3.6 review round), so an unknown reason *or* one that
   * belongs to the other role never reaches the adapter, both surfacing as
   * the identical `400 INVALID_REASON`. */
  app.post("/bookings/:id/dispute", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    const body = await c.req.json().catch(() => undefined);
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    if (!reason) {
      return c.json({ code: "invalid_request", message: "reason is required." }, 400);
    }
    try {
      const result = await openDispute(db, bookingId, c.get("walletAddress"), reason as DisputeReason, escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof InvalidDisputeReasonError) {
        return c.json({ code: "INVALID_REASON", message: error.message }, 400);
      }
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** Pactly's own dispute-resolver signature: gated to an admin wallet
   * ({@link requireAdmin}, `404` otherwise) that is *also*
   * `config.trustlessWorkPlatformAddress` -- an admin who is not the
   * dispute resolver gets `403 NOT_DISPUTE_RESOLVER`, never a silent
   * success building an XDR nobody can actually sign as the resolver. */
  app.post("/admin/bookings/:id/resolve", requirePactlyAuth, requireAdmin, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    if (c.get("walletAddress") !== config.trustlessWorkPlatformAddress) {
      return c.json(
        { code: "NOT_DISPUTE_RESOLVER", message: "This admin wallet is not Pactly's dispute resolver." },
        403,
      );
    }
    const body = await c.req.json().catch(() => undefined);
    const outcome = typeof body?.outcome === "string" ? body.outcome : undefined;
    if (!outcome || !(DISPUTE_OUTCOMES as readonly string[]).includes(outcome)) {
      return c.json(
        { code: "invalid_request", message: `outcome must be one of ${DISPUTE_OUTCOMES.join(", ")}.` },
        400,
      );
    }
    const existing = await getBookingById(db, bookingId);
    if (!existing) {
      return c.json({ code: "BOOKING_NOT_FOUND", message: "No booking was found with that id." }, 404);
    }
    try {
      const result = await resolveBookingDispute(db, bookingId, outcome as DisputeOutcome, escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** The admin "Resolutions" list: every dispute the chain still shows as
   * open, plus who opened it, why, and the policy's own suggested outcome
   * -- guidance only, never applied automatically (Story 3.6's own
   * Boundaries: "The admin may pick either outcome"). Any admin wallet may
   * view this, whether or not it is also the dispute resolver -- only
   * `/admin/bookings/:id/resolve` itself needs that stricter check. */
  app.get("/admin/disputes", requirePactlyAuth, requireAdmin, async (c) => {
    const disputes = await listOpenDisputes(db);
    return c.json({ disputes });
  });

  // ---------------------------------------------------------------------
  // Story 3.7: paying the balance before the session. Two independent
  // paths (AD-3: neither ever touches `escrow_state` or the Trustless Work
  // adapter) -- through Pactly (a plain Stellar payment this backend
  // builds, the client signs, this backend submits and polls to a
  // confirmed ledger result), or in person (the provider's own record).
  // ---------------------------------------------------------------------

  /** A Stellar payment failure translated into the route's own envelope --
   * shared by `balance/submit`, mirroring `escrowErrorResponse` above.
   * Never a raw body or stack trace. */
  function paymentErrorResponse(error: PaymentFailedError | PaymentUnavailableError) {
    if (error instanceof PaymentFailedError) {
      return { code: "PAYMENT_FAILED", message: "The payment could not be completed. Your balance is still unpaid.", status: 502 as const };
    }
    return {
      code: "PAYMENT_UNAVAILABLE",
      message: "The Stellar network is unavailable right now. Your balance is still unpaid.",
      status: 503 as const,
    };
  }

  app.post("/bookings/:id/balance/pay", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await buildBalancePayment(db, bookingId, c.get("walletAddress"), buildBalancePaymentDeps);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof NothingToPayError) {
        return c.json({ code: "NOTHING_TO_PAY", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/balance/submit", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      // Same discipline as the escrow submit route: ownership resolves
      // before the body is even parsed for its own shape.
      await getBookingForClient(db, bookingId, c.get("walletAddress"));
      const body = await c.req.json().catch(() => undefined);
      const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : undefined;
      if (!signedXdr) {
        return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
      }
      const result = await submitBalancePayment(db, bookingId, c.get("walletAddress"), signedXdr, submitBalancePaymentDeps);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof XdrMismatchError) {
        return c.json({ code: "XDR_MISMATCH", message: error.message }, 409);
      }
      if (error instanceof PaymentFailedError || error instanceof PaymentUnavailableError) {
        const response = paymentErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** The provider's own "I received this in person" record -- resolved
   * from the caller's own wallet, so a client (or anyone else's provider
   * profile) calling this on someone else's booking gets the same
   * `404 BOOKING_NOT_FOUND` every other ownership check in this file
   * gives. */
  app.post("/bookings/:id/balance/mark-cash", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await markBalancePaidCash(db, bookingId, c.get("walletAddress"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      throw error;
    }
  });

  return app;
}
