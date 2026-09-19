/**
 * `services/profile.ts`'s marketplace-listing filter (PRD Story 4.1 AC4):
 * an unapproved provider profile must never come back from a marketplace
 * listing. Does not touch `src/chain/` or `src/config.ts`, so no network
 * isolation setup is needed here.
 *
 * Also covers Story 3.1: deposit math, the rules/availability validation
 * bounds, the shared profile view, and the four service functions the
 * `/providers/:id`, `/me/provider`, `/me/provider/rules` and
 * `/me/provider/availability` routes call through -- every row of the
 * story's own I/O matrix that is reachable below the HTTP layer.
 * `test/app-providers.test.ts` covers the same matrix again at the HTTP
 * boundary (status codes, envelope shape).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeDepositAmount,
  getOwnProviderProfile,
  getPublicProviderProfile,
  InvalidAvailabilitySlotsError,
  InvalidProviderRulesError,
  listCategoriesWithProviderCounts,
  listDiscoverProviders,
  listMarketplaceProfiles,
  NotAProviderError,
  ProviderNotFoundError,
  suggestDiscoverQueries,
  updateProviderAvailability,
  updateProviderRules,
  validateAvailabilitySlots,
  validateProviderRules,
} from "../src/services/profile.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { closeDatabase, openTestDatabase, seedCategory, seedProviderProfile } from "./helpers.js";

test("listMarketplaceProfiles returns only approved profiles", async () => {
  const result = openTestDatabase();
  try {
    const approvedId = await seedProviderProfile(result, { isApproved: true });
    await seedProviderProfile(result, { isApproved: false });

    const profiles = await listMarketplaceProfiles(result.db);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.id, approvedId);
    assert.equal(profiles[0]?.isApproved, true);
  } finally {
    closeDatabase(result);
  }
});

test("listMarketplaceProfiles filtered by category still excludes unapproved profiles", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result);
    const approvedId = await seedProviderProfile(result, { categoryId, isApproved: true });
    await seedProviderProfile(result, { categoryId, isApproved: false });
    // A different category entirely, also approved -- must not leak into a
    // category-scoped listing.
    await seedProviderProfile(result, { isApproved: true });

    const profiles = await listMarketplaceProfiles(result.db, categoryId);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.id, approvedId);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// Story 3.1
// ---------------------------------------------------------------------------

test("computeDepositAmount floors price * depositRateBps / 10000", () => {
  assert.equal(computeDepositAmount("10000000", 2000), "2000000"); // 20% of 1.00 USDC
  assert.equal(computeDepositAmount("100", 1), "0"); // floors, does not round up
  assert.equal(computeDepositAmount("170141183460469231731687303715884105727", 10000), "170141183460469231731687303715884105727");
});

test("validateProviderRules accepts a valid set of rules", () => {
  const details = validateProviderRules({ priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 24 });
  assert.deepEqual(details, {});
});

test("validateProviderRules rejects a non-positive-integer priceAmount", () => {
  for (const priceAmount of ["0", "-5", "1.5", "abc", ""]) {
    const details = validateProviderRules({ priceAmount, depositRateBps: 2000, cancellationWindowHours: 24 });
    assert.equal(typeof details.priceAmount, "string", `expected priceAmount "${priceAmount}" to be rejected`);
  }
});

test("validateProviderRules rejects depositRateBps outside 1-10000", () => {
  for (const depositRateBps of [0, -1, 10001, 1.5]) {
    const details = validateProviderRules({ priceAmount: "10000000", depositRateBps, cancellationWindowHours: 24 });
    assert.equal(typeof details.depositRateBps, "string", `expected bps ${depositRateBps} to be rejected`);
  }
  assert.deepEqual(validateProviderRules({ priceAmount: "10000000", depositRateBps: 1, cancellationWindowHours: 24 }), {});
  assert.deepEqual(validateProviderRules({ priceAmount: "10000000", depositRateBps: 10000, cancellationWindowHours: 24 }), {});
});

test("validateProviderRules rejects cancellationWindowHours outside 0-720", () => {
  for (const cancellationWindowHours of [-1, 721, 1.5]) {
    const details = validateProviderRules({ priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours });
    assert.equal(typeof details.cancellationWindowHours, "string", `expected window ${cancellationWindowHours} to be rejected`);
  }
  assert.deepEqual(validateProviderRules({ priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 0 }), {});
  assert.deepEqual(validateProviderRules({ priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 720 }), {});
});

test("validateProviderRules rejects a deposit that floors to zero", () => {
  // price 99, bps 1 -> 99 * 1 / 10000 = 0 (floors to zero)
  const details = validateProviderRules({ priceAmount: "99", depositRateBps: 1, cancellationWindowHours: 24 });
  assert.equal(typeof details.depositRateBps, "string");
});

// A "now" that already sits on the 15-minute boundary itself, so
// `now + <multiple of 900>` stays on the boundary too -- the validator
// checks alignment against the epoch, not relative to `now`.
const ALIGNED_NOW = 999_900; // 999_900 / 900 = 1111, exact

test("validateAvailabilitySlots accepts a valid, non-overlapping, future set", () => {
  const now = ALIGNED_NOW;
  const boundary = 900; // 15 minutes
  const slots = [now + boundary, now + boundary + 3600];
  const details = validateAvailabilitySlots(slots, 50, now);
  assert.deepEqual(details, {});
});

test("validateAvailabilitySlots rejects a slot in the past", () => {
  const now = ALIGNED_NOW;
  const details = validateAvailabilitySlots([now - 900, now + 900], 50, now);
  assert.deepEqual(details.invalid, [now - 900]);
});

test("validateAvailabilitySlots rejects a slot more than 60 days ahead", () => {
  const now = 1_000_000;
  const tooFar = now + 61 * 24 * 60 * 60;
  const details = validateAvailabilitySlots([tooFar], 50, now);
  assert.deepEqual(details.invalid, [tooFar]);
});

test("validateAvailabilitySlots rejects a slot not on a 15-minute boundary", () => {
  const now = 1_000_000;
  const offBoundary = now + 100;
  const details = validateAvailabilitySlots([offBoundary], 50, now);
  assert.deepEqual(details.invalid, [offBoundary]);
});

test("validateAvailabilitySlots rejects two slots overlapping within sessionLengthMinutes", () => {
  const now = 1_000_000;
  const first = now + 900;
  const second = first + 900; // 15 minutes later, session is 50 minutes -- overlaps
  const details = validateAvailabilitySlots([first, second], 50, now);
  assert.deepEqual(details.overlapping, [second]);
});

test("validateAvailabilitySlots accepts back-to-back slots exactly sessionLengthMinutes apart", () => {
  const now = ALIGNED_NOW;
  const sessionLengthMinutes = 60;
  const first = now + 900;
  const second = first + sessionLengthMinutes * 60;
  const details = validateAvailabilitySlots([first, second], sessionLengthMinutes, now);
  assert.deepEqual(details, {});
});

test("validateAvailabilitySlots rejects more than 500 slots", () => {
  const now = 1_000_000;
  const slots = Array.from({ length: 501 }, (_, i) => now + (i + 1) * 3600);
  const details = validateAvailabilitySlots(slots, 30, now);
  assert.equal(typeof details.count, "string");
});

test("getPublicProviderProfile returns the full view for an approved profile, slots limited to 30 days", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result);
    const id = await seedProviderProfile(result, {
      categoryId,
      isApproved: true,
      displayName: "Dr. Elif Aydın",
      title: "Clinical psychologist",
      location: "Istanbul",
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
      sessionLengthMinutes: 50,
    });
    const now = 1_000_000;
    const withinWindow = now + 10 * 24 * 60 * 60;
    const beyondWindow = now + 40 * 24 * 60 * 60;
    await replaceFutureSlots(result.db, id, [withinWindow, beyondWindow], now);

    const view = await getPublicProviderProfile(result.db, id, now);
    assert.equal(view.displayName, "Dr. Elif Aydın");
    assert.equal(view.title, "Clinical psychologist");
    assert.equal(view.category.id, categoryId);
    assert.equal(view.location, "Istanbul");
    assert.equal(view.price.amount, "10000000");
    assert.equal(view.price.asset, "USDC");
    assert.equal(view.deposit.amount, "2000000");
    assert.equal(view.deposit.asset, "USDC");
    assert.equal(view.depositRateBps, 2000);
    assert.equal(view.cancellationWindowHours, 24);
    assert.equal(view.isApproved, true);
    assert.deepEqual(view.slots, [withinWindow]);
  } finally {
    closeDatabase(result);
  }
});

test("getPublicProviderProfile throws ProviderNotFoundError for an unapproved profile", async () => {
  const result = openTestDatabase();
  try {
    const id = await seedProviderProfile(result, { isApproved: false });
    await assert.rejects(() => getPublicProviderProfile(result.db, id), ProviderNotFoundError);
  } finally {
    closeDatabase(result);
  }
});

test("getPublicProviderProfile throws ProviderNotFoundError for an unknown id", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => getPublicProviderProfile(result.db, "no-such-id"), ProviderNotFoundError);
  } finally {
    closeDatabase(result);
  }
});

test("getOwnProviderProfile returns the profile for a provider's wallet, including while unapproved, with all future slots (no 30-day cap)", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GOWNERWALLET1";
    const id = await seedProviderProfile(result, { walletAddress, isApproved: false });
    const now = 1_000_000;
    const farFuture = now + 40 * 24 * 60 * 60;
    await replaceFutureSlots(result.db, id, [farFuture], now);

    const view = await getOwnProviderProfile(result.db, walletAddress, now);
    assert.equal(view.isApproved, false);
    assert.deepEqual(view.slots, [farFuture]);
  } finally {
    closeDatabase(result);
  }
});

test("getOwnProviderProfile throws NotAProviderError for a wallet with no provider profile", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => getOwnProviderProfile(result.db, "GNOTAPROVIDER"), NotAProviderError);
  } finally {
    closeDatabase(result);
  }
});

test("updateProviderRules saves valid rules and returns the recomputed deposit", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GRULESWALLET1";
    await seedProviderProfile(result, { walletAddress, priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 24 });

    const view = await updateProviderRules(result.db, walletAddress, {
      priceAmount: "50000000",
      depositRateBps: 3000,
      cancellationWindowHours: 48,
    });
    assert.equal(view.price.amount, "50000000");
    assert.equal(view.depositRateBps, 3000);
    assert.equal(view.cancellationWindowHours, 48);
    assert.equal(view.deposit.amount, "15000000");
  } finally {
    closeDatabase(result);
  }
});

test("updateProviderRules saves nothing and throws InvalidProviderRulesError for out-of-bounds input", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GRULESWALLET2";
    await seedProviderProfile(result, { walletAddress, priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 24 });

    await assert.rejects(
      () => updateProviderRules(result.db, walletAddress, { priceAmount: "10000000", depositRateBps: 20000, cancellationWindowHours: 24 }),
      InvalidProviderRulesError,
    );

    const unchanged = await getOwnProviderProfile(result.db, walletAddress);
    assert.equal(unchanged.depositRateBps, 2000);
  } finally {
    closeDatabase(result);
  }
});

test("updateProviderRules throws NotAProviderError for a wallet with no provider profile", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(
      () => updateProviderRules(result.db, "GNOTAPROVIDER", { priceAmount: "10000000", depositRateBps: 2000, cancellationWindowHours: 24 }),
      NotAProviderError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("updateProviderAvailability saves a valid, deduplicated, sorted set of future slots", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GAVAILWALLET1";
    await seedProviderProfile(result, { walletAddress, sessionLengthMinutes: 50 });
    // Aligned to the 15-minute boundary the validator checks against the
    // epoch (not relative to `now`), and comfortably in the future
    // regardless of the real clock.
    const rawNow = Math.floor(Date.now() / 1000) + 10;
    const now = rawNow - (rawNow % 900);
    const first = now + 900;
    const second = now + 900 + 3600;

    const view = await updateProviderAvailability(result.db, walletAddress, [second, first, first], now);
    assert.deepEqual(view.slots, [first, second]);
  } finally {
    closeDatabase(result);
  }
});

test("updateProviderAvailability saves nothing and throws InvalidAvailabilitySlotsError for a past slot", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GAVAILWALLET2";
    const id = await seedProviderProfile(result, { walletAddress, sessionLengthMinutes: 50 });
    const now = Math.floor(Date.now() / 1000) + 10;
    const keep = now + 900;
    await replaceFutureSlots(result.db, id, [keep], now);

    await assert.rejects(
      () => updateProviderAvailability(result.db, walletAddress, [now - 900], now),
      InvalidAvailabilitySlotsError,
    );

    const unchanged = await getOwnProviderProfile(result.db, walletAddress, now);
    assert.deepEqual(unchanged.slots, [keep]);
  } finally {
    closeDatabase(result);
  }
});

test("updateProviderAvailability throws NotAProviderError for a wallet with no provider profile", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => updateProviderAvailability(result.db, "GNOTAPROVIDER", []), NotAProviderError);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// Story 3.2: the Discover list's card objects and category counts.
// ---------------------------------------------------------------------------

test("listDiscoverProviders returns only approved providers, as card objects with the deposit and slots", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const approvedId = await seedProviderProfile(result, {
      isApproved: true,
      displayName: "Dr. Elif Aydın",
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
    });
    await replaceFutureSlots(result.db, approvedId, [now + 900, now + 1800, now + 2700, now + 3600], now);
    await seedProviderProfile(result, { isApproved: false });

    const cards = await listDiscoverProviders(result.db, undefined, {}, now);
    assert.equal(cards.length, 1);
    const card = cards[0]!;
    assert.equal(card.id, approvedId);
    assert.equal(card.displayName, "Dr. Elif Aydın");
    assert.deepEqual(card.deposit, { amount: "2000000", asset: "USDC" });
    assert.equal(card.cancellationWindowHours, 24);
    assert.equal(card.providerCancellationCount, 0);
    // At most three, even though four are open.
    assert.deepEqual(card.earliestSlots, [now + 900, now + 1800, now + 2700]);
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders filters by category slug", async () => {
  const result = openTestDatabase();
  try {
    const categoryA = await seedCategory(result, "cat-a");
    const categoryB = await seedCategory(result, "cat-b");
    const inA = await seedProviderProfile(result, { categoryId: categoryA, isApproved: true });
    await seedProviderProfile(result, { categoryId: categoryB, isApproved: true });

    // `seedCategory`'s own slug shape: `consulting-${id}`.
    const cards = await listDiscoverProviders(result.db, `consulting-${categoryA}`);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.id, inA);
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders gives an empty list for an unknown category slug, never an error", async () => {
  const result = openTestDatabase();
  try {
    await seedProviderProfile(result, { isApproved: true });
    const cards = await listDiscoverProviders(result.db, "does-not-exist");
    assert.deepEqual(cards, []);
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders sorts by soonest open slot ascending, slotless providers last, ties by name", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const soonest = await seedProviderProfile(result, { isApproved: true, displayName: "Soonest Provider" });
    const later = await seedProviderProfile(result, { isApproved: true, displayName: "Later Provider" });
    const slotlessB = await seedProviderProfile(result, { isApproved: true, displayName: "Zeta Slotless" });
    const slotlessA = await seedProviderProfile(result, { isApproved: true, displayName: "Alpha Slotless" });
    await replaceFutureSlots(result.db, soonest, [now + 900], now);
    await replaceFutureSlots(result.db, later, [now + 3600], now);

    const cards = await listDiscoverProviders(result.db, undefined, {}, now);
    assert.deepEqual(
      cards.map((card) => card.id),
      [soonest, later, slotlessA, slotlessB],
    );
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders breaks a tie between two providers with the same earliest slot by displayName ascending", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const zeta = await seedProviderProfile(result, { isApproved: true, displayName: "Zeta Provider" });
    const alpha = await seedProviderProfile(result, { isApproved: true, displayName: "Alpha Provider" });
    await replaceFutureSlots(result.db, zeta, [now + 900], now);
    await replaceFutureSlots(result.db, alpha, [now + 900], now);

    const cards = await listDiscoverProviders(result.db, undefined, {}, now);
    assert.deepEqual(
      cards.map((card) => card.id),
      [alpha, zeta],
    );
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders lists a provider whose slots are all in the past with earliestSlots: [] and sorts it last", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const hasFutureSlot = await seedProviderProfile(result, { isApproved: true, displayName: "Has A Slot" });
    const allPast = await seedProviderProfile(result, { isApproved: true, displayName: "All Past" });
    await replaceFutureSlots(result.db, hasFutureSlot, [now + 900], now);
    // Planted as "future" relative to an earlier reference point, then
    // viewed as of `now` -- same technique the availability-slots tests use
    // to seed a genuinely past-relative-to-now row.
    await replaceFutureSlots(result.db, allPast, [now - 3600], now - 7200);

    const cards = await listDiscoverProviders(result.db, undefined, {}, now);
    const allPastCard = cards.find((card) => card.id === allPast);
    assert.deepEqual(allPastCard?.earliestSlots, []);
    assert.deepEqual(
      cards.map((card) => card.id),
      [hasFutureSlot, allPast],
    );
  } finally {
    closeDatabase(result);
  }
});

test("listCategoriesWithProviderCounts counts only approved providers per category", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result);
    await seedProviderProfile(result, { categoryId, isApproved: true });
    await seedProviderProfile(result, { categoryId, isApproved: true });
    await seedProviderProfile(result, { categoryId, isApproved: false });
    const emptyCategoryId = await seedCategory(result);

    const categories = await listCategoriesWithProviderCounts(result.db);
    const populated = categories.find((category) => category.id === categoryId);
    const empty = categories.find((category) => category.id === emptyCategoryId);
    assert.equal(populated?.providerCount, 2);
    assert.equal(empty?.providerCount, 0);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// Story 3.3: search and filters -- one test per I/O matrix row that is
// reachable below the HTTP layer. `test/app-providers.test.ts` covers the
// same matrix again at the HTTP boundary (query-string parsing, envelope
// shape).
// ---------------------------------------------------------------------------

test("listDiscoverProviders: text search matches name, title, bio and category name, case-insensitively (AC1)", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, undefined, "Fitness and beauty");
    const byName = await seedProviderProfile(result, { categoryId, isApproved: true, displayName: "Marmara Hair Clinic" });
    const byTitle = await seedProviderProfile(result, { categoryId, isApproved: true, title: "Hair transplant · FUE consult" });
    const byBio = await seedProviderProfile(result, { categoryId, isApproved: true, bio: "We specialise in HAIR restoration." });
    // Matches only through its category's own name -- neither the
    // provider's name, title nor bio mentions "hair".
    const hairCategoryId = await seedCategory(result, undefined, "Hair transplant clinics");
    const byCategory = await seedProviderProfile(result, { categoryId: hairCategoryId, isApproved: true, displayName: "Zeynep" });
    const noMatch = await seedProviderProfile(result, { categoryId, isApproved: true, displayName: "Northside Barber" });

    const cards = await listDiscoverProviders(result.db, undefined, { query: "hair" });
    const ids = cards.map((card) => card.id).sort();
    assert.deepEqual(ids, [byBio, byCategory, byName, byTitle].sort());
    assert.ok(!ids.includes(noMatch));
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: only approved providers are ever matched by search (AC1)", async () => {
  const result = openTestDatabase();
  try {
    await seedProviderProfile(result, { isApproved: false, displayName: "Hair Clinic Unapproved" });
    const cards = await listDiscoverProviders(result.db, undefined, { query: "hair" });
    assert.deepEqual(cards, []);
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: combined query + category + filters is their intersection", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, undefined, "Fitness and beauty");
    const otherCategoryId = await seedCategory(result, undefined, "Consulting");
    const match = await seedProviderProfile(result, {
      categoryId,
      isApproved: true,
      displayName: "Hair Studio",
      sessionFormat: "in_person",
    });
    // Same query and format, wrong category.
    await seedProviderProfile(result, {
      categoryId: otherCategoryId,
      isApproved: true,
      displayName: "Hair Consulting",
      sessionFormat: "in_person",
    });
    // Same query and category, wrong format.
    await seedProviderProfile(result, {
      categoryId,
      isApproved: true,
      displayName: "Hair Studio Video",
      sessionFormat: "video",
    });

    const cards = await listDiscoverProviders(result.db, `consulting-${categoryId}`, {
      query: "hair",
      formats: ["in_person"],
    });
    assert.deepEqual(cards.map((card) => card.id), [match]);
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: price range is compared as BigInt, min <= price <= max", async () => {
  const result = openTestDatabase();
  try {
    const cheap = await seedProviderProfile(result, { isApproved: true, priceAmount: "5000000" });
    const mid = await seedProviderProfile(result, { isApproved: true, priceAmount: "50000000" });
    // A price with more digits than the bound -- would sort before a
    // shorter numeric string under plain text comparison, proving this is
    // really BigInt, not lexicographic.
    const expensive = await seedProviderProfile(result, { isApproved: true, priceAmount: "500000000" });

    const cards = await listDiscoverProviders(result.db, undefined, {
      minPriceAmount: "10000000",
      maxPriceAmount: "100000000",
    });
    assert.deepEqual(cards.map((card) => card.id), [mid]);
    void cheap;
    void expensive;
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: deposit cap keeps depositRateBps <= maxDepositRateBps", async () => {
  const result = openTestDatabase();
  try {
    const low = await seedProviderProfile(result, { isApproved: true, depositRateBps: 2000 });
    const high = await seedProviderProfile(result, { isApproved: true, depositRateBps: 5000 });

    const cards = await listDiscoverProviders(result.db, undefined, { maxDepositRateBps: 3000 });
    assert.deepEqual(cards.map((card) => card.id), [low]);
    void high;
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: availability 24h keeps only a provider with a future slot within 24h", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const soon = await seedProviderProfile(result, { isApproved: true, displayName: "Soon" });
    const later = await seedProviderProfile(result, { isApproved: true, displayName: "Later" });
    const none = await seedProviderProfile(result, { isApproved: true, displayName: "None" });
    await replaceFutureSlots(result.db, soon, [now + 3600], now);
    await replaceFutureSlots(result.db, later, [now + 8 * 24 * 60 * 60], now);

    const cards = await listDiscoverProviders(result.db, undefined, { availability: "24h" }, now);
    assert.deepEqual(cards.map((card) => card.id), [soon]);
    void later;
    void none;
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: availability week keeps a slot within 7 days but excludes one further out", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const withinWeek = await seedProviderProfile(result, { isApproved: true, displayName: "Within Week" });
    const beyondWeek = await seedProviderProfile(result, { isApproved: true, displayName: "Beyond Week" });
    await replaceFutureSlots(result.db, withinWeek, [now + 3 * 24 * 60 * 60], now);
    await replaceFutureSlots(result.db, beyondWeek, [now + 10 * 24 * 60 * 60], now);

    const cards = await listDiscoverProviders(result.db, undefined, { availability: "week" }, now);
    assert.deepEqual(cards.map((card) => card.id), [withinWeek]);
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: format filter matches any of several formats (multi-select OR)", async () => {
  const result = openTestDatabase();
  try {
    const inPerson = await seedProviderProfile(result, { isApproved: true, sessionFormat: "in_person" });
    const video = await seedProviderProfile(result, { isApproved: true, sessionFormat: "video" });
    const other = await seedProviderProfile(result, { isApproved: true, sessionFormat: "phone" });

    const cards = await listDiscoverProviders(result.db, undefined, { formats: ["in_person", "video"] });
    assert.deepEqual(cards.map((card) => card.id).sort(), [inPerson, video].sort());
    void other;
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: an unknown format value matches nothing for that value", async () => {
  const result = openTestDatabase();
  try {
    await seedProviderProfile(result, { isApproved: true, sessionFormat: "in_person" });
    const cards = await listDiscoverProviders(result.db, undefined, { formats: ["carrier-pigeon"] });
    assert.deepEqual(cards, []);
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders: a query containing % or _ is matched literally, not as a SQL wildcard", async () => {
  const result = openTestDatabase();
  try {
    const literal = await seedProviderProfile(result, { isApproved: true, displayName: "100% Hair_Clinic" });
    // If `%`/`_` acted as SQL wildcards, this would also match `literal`
    // (and everything else) since `%` alone means "anything".
    const decoy = await seedProviderProfile(result, { isApproved: true, displayName: "Totally Different Name" });

    const cards = await listDiscoverProviders(result.db, undefined, { query: "100% hair_clinic" });
    assert.deepEqual(cards.map((card) => card.id), [literal]);
    void decoy;
  } finally {
    closeDatabase(result);
  }
});

test("suggestDiscoverQueries: q shorter than two characters is an empty list", async () => {
  const result = openTestDatabase();
  try {
    await seedProviderProfile(result, { isApproved: true, displayName: "Hair Clinic" });
    assert.deepEqual(await suggestDiscoverQueries(result.db, "h"), []);
    assert.deepEqual(await suggestDiscoverQueries(result.db, ""), []);
  } finally {
    closeDatabase(result);
  }
});

test("suggestDiscoverQueries: groups into category/service/provider, each with its approved-provider count", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, undefined, "Hair transplant clinics");
    await seedProviderProfile(result, {
      categoryId,
      isApproved: true,
      displayName: "Marmara Hair Clinic",
      title: "Hair transplant · FUE consult",
    });
    await seedProviderProfile(result, {
      categoryId,
      isApproved: true,
      displayName: "Second Hair Clinic",
      title: "Hair transplant · FUE consult",
    });
    // Unapproved -- must never contribute to any suggestion's count.
    await seedProviderProfile(result, {
      categoryId,
      isApproved: false,
      displayName: "Hair Clinic Pending",
      title: "Hair transplant · FUE consult",
    });

    const suggestions = await suggestDiscoverQueries(result.db, "hair");
    const category = suggestions.find((s) => s.kind === "category");
    const service = suggestions.find((s) => s.kind === "service");
    const providers = suggestions.filter((s) => s.kind === "provider");

    assert.equal(category?.label, "Hair transplant clinics");
    assert.equal(category?.count, 2);
    assert.equal(service?.label, "Hair transplant · FUE consult");
    assert.equal(service?.count, 2);
    assert.equal(providers.length, 2);
    assert.ok(providers.every((p) => p.count === 1));
  } finally {
    closeDatabase(result);
  }
});

test("suggestDiscoverQueries: caps at 8 suggestions total", async () => {
  const result = openTestDatabase();
  try {
    for (let i = 0; i < 10; i += 1) {
      await seedProviderProfile(result, { isApproved: true, displayName: `Hair Clinic ${i}` });
    }
    const suggestions = await suggestDiscoverQueries(result.db, "hair");
    assert.ok(suggestions.length <= 8);
  } finally {
    closeDatabase(result);
  }
});
