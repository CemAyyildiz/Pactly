/**
 * `services/profile.ts`'s marketplace-listing filter (PRD Story 4.1 AC4):
 * an unapproved provider profile must never come back from a marketplace
 * listing. Does not touch `src/chain/` or `src/config.ts`, so no network
 * isolation setup is needed here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { listMarketplaceProfiles } from "../src/services/profile.js";
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
