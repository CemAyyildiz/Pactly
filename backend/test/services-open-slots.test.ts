/**
 * Review follow-up: a slot that currently carries an active booking (a
 * non-expired hold, or a locked escrow) must never be advertised as
 * bookable anywhere a client reads slots from -- the public provider
 * profile (`getPublicProviderProfile`) and the Discover card
 * (`listDiscoverProviders`'s own `earliestSlots`). Both already build on
 * `db/availabilitySlots.ts`'s `listOpenFutureSlots`/
 * `listEarliestFutureSlotsByProvider`, which this file exercises through
 * the actual service functions a route calls, not just the db layer
 * directly (`db-availability-slots.test.ts`'s own job).
 *
 * New file per review instruction, so as not to touch `services-profile.
 * test.ts` (owned by a concurrent Discover-side change) or `profile.ts`
 * itself -- this file only ever imports and calls existing exports.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import { getPublicProviderProfile, listDiscoverProviders } from "../src/services/profile.js";
import { holdSlot } from "../src/services/booking.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) };

test("getPublicProviderProfile's own slots exclude one that is currently held", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const heldStart = now + 900;
    const openStart = now + 1800;
    await replaceFutureSlots(result.db, providerProfileId, [heldStart, openStart], now);

    await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: heldStart },
      { now, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );

    const profile = await getPublicProviderProfile(result.db, providerProfileId, now);
    assert.deepEqual(profile.slots, [openStart]);
  } finally {
    closeDatabase(result);
  }
});

test("getPublicProviderProfile's own slots exclude one that is locked (escrow_state set)", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const lockedStart = now + 900;
    const openStart = now + 1800;
    await replaceFutureSlots(result.db, providerProfileId, [lockedStart, openStart], now);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: lockedStart },
      { now, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );
    await updateEscrowContractId(result.db, hold.bookingId, "CFAKECONTRACT000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, hold.bookingId, "locked");

    const profile = await getPublicProviderProfile(result.db, providerProfileId, now);
    assert.deepEqual(profile.slots, [openStart]);
  } finally {
    closeDatabase(result);
  }
});

test("listDiscoverProviders' own card earliestSlots exclude a held slot, and fall through to the next open one", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, displayName: "Held-Slot Clinic" });
    const now = 1_000_000;
    const heldStart = now + 900; // earliest, but held
    const openStart = now + 1800; // the next-earliest, still open
    await replaceFutureSlots(result.db, providerProfileId, [heldStart, openStart], now);

    await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: heldStart },
      { now, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );

    const cards = await listDiscoverProviders(result.db, undefined, {}, now);
    const card = cards.find((c) => c.id === providerProfileId);
    assert.ok(card, "the provider must still appear on the Discover list");
    assert.deepEqual(card!.earliestSlots, [openStart]);
  } finally {
    closeDatabase(result);
  }
});

test("a provider whose only future slot is held has an empty earliestSlots, not a stale/held one", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const heldStart = now + 900;
    await replaceFutureSlots(result.db, providerProfileId, [heldStart], now);

    await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: heldStart },
      { now, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );

    const cards = await listDiscoverProviders(result.db, undefined, {}, now);
    const card = cards.find((c) => c.id === providerProfileId);
    assert.ok(card);
    assert.deepEqual(card!.earliestSlots, []);
  } finally {
    closeDatabase(result);
  }
});
