/**
 * Story 3.1's five HTTP routes (`/categories`, `/providers/:id`,
 * `/me/provider`, `/me/provider/rules`, `/me/provider/availability`),
 * driven through Hono's own `app.request(...)` like `app.test.ts`. Covers
 * the I/O matrix's status codes and envelope shapes at the HTTP boundary;
 * `services-profile.test.ts` covers the same matrix's logic underneath.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { closeDatabase, openTestDatabase, seedCategory, seedProviderProfile } from "./helpers.js";

test("GET /categories returns every category", async () => {
  const result = openTestDatabase();
  try {
    await seedCategory(result, "cat-1");
    await seedCategory(result, "cat-2");
    const app = createApp(result.db);
    const response = await app.request("/categories");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { categories: Array<{ id: string }> };
    assert.equal(body.categories.length, 2);
  } finally {
    closeDatabase(result);
  }
});

test("GET /categories includes providerCount, approved providers only (Story 3.2 AC1)", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-counted");
    await seedProviderProfile(result, { categoryId, isApproved: true });
    await seedProviderProfile(result, { categoryId, isApproved: false });
    const app = createApp(result.db);
    const response = await app.request("/categories");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { categories: Array<{ id: string; providerCount: number }> };
    const category = body.categories.find((c) => c.id === categoryId);
    assert.equal(category?.providerCount, 1);
  } finally {
    closeDatabase(result);
  }
});

test("GET /providers lists only approved providers as card objects, with the deposit pill's two facts and earliestSlots", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const approvedId = await seedProviderProfile(result, {
      isApproved: true,
      displayName: "Dr. Elif Aydın",
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
    });
    await replaceFutureSlots(result.db, approvedId, [now + 900, now + 1800], now);
    await seedProviderProfile(result, { isApproved: false });
    const app = createApp(result.db);
    const response = await app.request("/providers");
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      providers: Array<{ id: string; deposit: { amount: string; asset: string }; cancellationWindowHours: number; earliestSlots: number[] }>;
    };
    assert.equal(body.providers.length, 1);
    const provider = body.providers[0]!;
    assert.equal(provider.id, approvedId);
    assert.deepEqual(provider.deposit, { amount: "2000000", asset: "USDC" });
    assert.equal(provider.cancellationWindowHours, 24);
    assert.deepEqual(provider.earliestSlots, [now + 900, now + 1800]);
  } finally {
    closeDatabase(result);
  }
});

test("GET /providers?category=<slug> filters to that category's approved providers", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-filter");
    const inCategory = await seedProviderProfile(result, { categoryId, isApproved: true });
    await seedProviderProfile(result, { isApproved: true });
    const app = createApp(result.db);
    const response = await app.request("/providers?category=consulting-cat-filter");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { providers: Array<{ id: string }> };
    assert.deepEqual(
      body.providers.map((p) => p.id),
      [inCategory],
    );
  } finally {
    closeDatabase(result);
  }
});

test("GET /providers?category=<unknown-slug> gives 200 with an empty list, never an error", async () => {
  const result = openTestDatabase();
  try {
    await seedProviderProfile(result, { isApproved: true });
    const app = createApp(result.db);
    const response = await app.request("/providers?category=does-not-exist");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { providers: unknown[] };
    assert.deepEqual(body.providers, []);
  } finally {
    closeDatabase(result);
  }
});

test("GET /providers/:id returns the public view for an approved provider, with the deposit pill's two facts", async () => {
  const result = openTestDatabase();
  try {
    const id = await seedProviderProfile(result, {
      isApproved: true,
      displayName: "Dr. Elif Aydın",
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
    });
    const app = createApp(result.db);
    const response = await app.request(`/providers/${id}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.displayName, "Dr. Elif Aydın");
    assert.deepEqual(body.deposit, { amount: "2000000", asset: "USDC" });
    assert.equal(body.cancellationWindowHours, 24);
  } finally {
    closeDatabase(result);
  }
});

test("GET /providers/:id gives 404 PROVIDER_NOT_FOUND for an unapproved profile", async () => {
  const result = openTestDatabase();
  try {
    const id = await seedProviderProfile(result, { isApproved: false });
    const app = createApp(result.db);
    const response = await app.request(`/providers/${id}`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "PROVIDER_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("GET /providers/:id gives 404 PROVIDER_NOT_FOUND for an unknown id (same shape as unapproved)", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await app.request("/providers/does-not-exist");
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "PROVIDER_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("GET /providers/:id only returns slots starting after now", async () => {
  const result = openTestDatabase();
  try {
    const id = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const past = now - 3600;
    const future = now + 3600;
    // Both values are "future" relative to this older reference point, so
    // replaceFutureSlots (a db-layer function with no business validation
    // of its own) accepts both -- planting a genuinely past-relative-to-now
    // row without a second write path.
    await replaceFutureSlots(result.db, id, [past, future], now - 7200);
    const app = createApp(result.db);
    const response = await app.request(`/providers/${id}`);
    const body = (await response.json()) as { slots: number[] };
    assert.deepEqual(body.slots, [future]);
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/provider returns the caller's own profile including while unapproved", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GHTTPPROVIDER1";
    await seedProviderProfile(result, { walletAddress, isApproved: false });
    const app = createApp(result.db);
    const token = await issuePactlyJwt(walletAddress);
    const response = await app.request("/me/provider", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { isApproved: boolean };
    assert.equal(body.isApproved, false);
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/provider gives 404 NOT_A_PROVIDER for a wallet with no profile", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const token = await issuePactlyJwt("GNOPROFILEWALLET");
    const response = await app.request("/me/provider", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "NOT_A_PROVIDER");
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/provider gives 401 with no token", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await app.request("/me/provider");
    assert.equal(response.status, 401);
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/provider gives 401 for a tampered token, even for a wallet that owns a profile", async () => {
  const result = openTestDatabase();
  try {
    await seedProviderProfile(result, { walletAddress: "GHTTPTAMPERED1" });
    const app = createApp(result.db);
    const response = await app.request("/me/provider", { headers: { authorization: "Bearer not.a.realtoken" } });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { code: string };
    assert.equal(typeof body.code, "string");
  } finally {
    closeDatabase(result);
  }
});

test("GET /me/provider gives 401 for an expired token, even for a wallet that owns a profile", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GHTTPEXPIRED1";
    await seedProviderProfile(result, { walletAddress });
    const app = createApp(result.db);
    // Issued as if two hours ago -- past the token's own one-hour TTL, so
    // it verifies as expired against the real, current clock below.
    const expiredToken = await issuePactlyJwt(walletAddress, { now: () => new Date(Date.now() - 2 * 60 * 60 * 1000) });
    const response = await app.request("/me/provider", { headers: { authorization: `Bearer ${expiredToken}` } });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { code: string };
    assert.equal(typeof body.code, "string");
  } finally {
    closeDatabase(result);
  }
});

test("PUT /me/provider/rules saves and returns the updated profile with the recomputed deposit", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GHTTPRULES1";
    await seedProviderProfile(result, { walletAddress, priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 24 });
    const app = createApp(result.db);
    const token = await issuePactlyJwt(walletAddress);
    const response = await app.request("/me/provider/rules", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "50000000", depositRateBps: 3000, cancellationWindowHours: 48 }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.depositRateBps, 3000);
    assert.deepEqual(body.deposit, { amount: "15000000", asset: "USDC" });
  } finally {
    closeDatabase(result);
  }
});

test("PUT /me/provider/rules gives 400 INVALID_RULES with details, saving nothing", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GHTTPRULES2";
    await seedProviderProfile(result, { walletAddress, priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 24 });
    const app = createApp(result.db);
    const token = await issuePactlyJwt(walletAddress);
    const response = await app.request("/me/provider/rules", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "10000000", depositRateBps: 99999, cancellationWindowHours: 24 }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string; details: Record<string, string> };
    assert.equal(body.code, "INVALID_RULES");
    assert.equal(typeof body.details.depositRateBps, "string");

    const unchangedResponse = await app.request("/me/provider", { headers: { authorization: `Bearer ${token}` } });
    const unchanged = (await unchangedResponse.json()) as { depositRateBps: number };
    assert.equal(unchanged.depositRateBps, 2000);
  } finally {
    closeDatabase(result);
  }
});

test("PUT /me/provider/rules gives 404 NOT_A_PROVIDER for a wallet with no profile", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const token = await issuePactlyJwt("GNOPROFILEWALLET2");
    const response = await app.request("/me/provider/rules", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 24 }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "NOT_A_PROVIDER");
  } finally {
    closeDatabase(result);
  }
});

test("PUT /me/provider/availability saves a valid set and returns it on the updated profile", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GHTTPAVAIL1";
    await seedProviderProfile(result, { walletAddress, sessionLengthMinutes: 50 });
    const app = createApp(result.db);
    const token = await issuePactlyJwt(walletAddress);
    const now = Math.floor(Date.now() / 1000) + 3600;
    const boundarySlot = now - (now % 900) + 900; // next 15-minute boundary after now
    const response = await app.request("/me/provider/availability", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slots: [boundarySlot] }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { slots: number[] };
    assert.deepEqual(body.slots, [boundarySlot]);
  } finally {
    closeDatabase(result);
  }
});

test("PUT /me/provider/availability gives 400 INVALID_SLOTS with the offending values, saving nothing", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GHTTPAVAIL2";
    await seedProviderProfile(result, { walletAddress, sessionLengthMinutes: 50 });
    const app = createApp(result.db);
    const token = await issuePactlyJwt(walletAddress);
    const pastSlot = Math.floor(Date.now() / 1000) - 3600;
    const response = await app.request("/me/provider/availability", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slots: [pastSlot] }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string; details: { invalid?: number[] } };
    assert.equal(body.code, "INVALID_SLOTS");
    assert.deepEqual(body.details.invalid, [pastSlot]);

    const unchangedResponse = await app.request("/me/provider", { headers: { authorization: `Bearer ${token}` } });
    const unchanged = (await unchangedResponse.json()) as { slots: number[] };
    assert.deepEqual(unchanged.slots, []);
  } finally {
    closeDatabase(result);
  }
});

test("PUT /me/provider/availability gives 404 NOT_A_PROVIDER for a wallet with no profile", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const token = await issuePactlyJwt("GNOPROFILEWALLET3");
    const response = await app.request("/me/provider/availability", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slots: [] }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "NOT_A_PROVIDER");
  } finally {
    closeDatabase(result);
  }
});
