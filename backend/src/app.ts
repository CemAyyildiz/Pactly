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

export function createApp(db: Db): App {
  const app: App = new Hono<{ Variables: Variables }>();

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

  return app;
}
