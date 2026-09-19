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
  BookingEscrowStateError,
  BookingHoldExpiredError,
  BookingNotFoundError,
  SlotTakenError,
  SlotUnavailableError,
  TooManyHoldsError,
  XdrMismatchError,
  fundDeposit,
  getBookingForClient,
  getBookingView,
  holdSlot,
  listBookingsForClient,
  listBookingsForProvider,
  lockDeposit,
  submitSignedTransaction,
} from "./services/booking.js";
import { EscrowApiError, EscrowConfigError, EscrowRequestError } from "./escrow/trustless-work/errors.js";
import { defaultEscrowAdapter } from "./escrow/trustless-work/client.js";
import type { EscrowAdapter } from "./escrow/interface.js";

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
}

export function createApp(db: Db, options: CreateAppOptions = {}): App {
  const app: App = new Hono<{ Variables: Variables }>();
  const escrowAdapter = options.escrowAdapter ?? defaultEscrowAdapter;

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

  app.post("/bookings/:id/submit", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      // Review follow-up: the owner check now runs *before* the body is
      // even parsed for its own shape -- a stranger's request gets the
      // identical 404 BOOKING_NOT_FOUND every other route gives them,
      // never a 400 that would first confirm the booking exists.
      // Submit is allowed after the hold expires (the spec's own "Never"
      // rule) -- `getBookingForClient` only ever checks existence and
      // ownership, never the hold's own clock.
      await getBookingForClient(db, bookingId, c.get("walletAddress"));
      const body = await c.req.json().catch(() => undefined);
      const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : undefined;
      if (!signedXdr) {
        return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
      }
      const result = await submitSignedTransaction(db, bookingId, signedXdr, escrowAdapter);
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

  return app;
}
