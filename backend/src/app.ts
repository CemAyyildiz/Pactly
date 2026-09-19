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
import { listCategories } from "./db/categories.js";
import {
  InvalidAvailabilitySlotsError,
  InvalidProviderRulesError,
  NotAProviderError,
  ProviderNotFoundError,
  getOwnProviderProfile,
  getPublicProviderProfile,
  updateProviderAvailability,
  updateProviderRules,
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

  app.get("/categories", async (c) => {
    const categories = await listCategories(db);
    return c.json({ categories });
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
