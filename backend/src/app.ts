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
  PactlyInvalidAccountError,
  PactlyJwtError,
} from "./auth/errors.js";

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
export async function requirePactlyAuth(c: Context<{ Variables: Variables }>, next: Next) {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
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

export function createApp(): App {
  const app: App = new Hono<{ Variables: Variables }>();

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
      const { walletAddress } = verifyPactlyChallenge(transaction);
      const token = await issuePactlyJwt(walletAddress);
      return c.json({ token, walletAddress });
    } catch (error) {
      if (error instanceof PactlyChallengeExpiredError) {
        return c.json({ code: "challenge_expired", message: error.message }, 401);
      }
      if (error instanceof PactlyChallengeInvalidError) {
        return c.json({ code: "challenge_invalid", message: error.message }, 401);
      }
      throw error;
    }
  });

  return app;
}
