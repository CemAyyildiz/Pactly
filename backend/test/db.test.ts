/**
 * Small db-layer tests: bookings, the event worker's cursor, and the
 * processed-events dedupe ledger, each against a real temporary SQLite
 * database. Includes the I/O matrix's amount round-trip row: an `i128`
 * amount at the top of the range stored and read back as the identical
 * string, with no precision lost.
 */
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";

import { getBookingById, updateBalanceState, updateEscrowContractId, updateEscrowState } from "../src/db/bookings.js";
import { getProviderProfileById, updateProviderProfileRules } from "../src/db/providerProfiles.js";
import { getAnchorJwt, upsertAnchorJwt } from "../src/db/anchorJwts.js";
import { redeemChallengeNonceIfUnused } from "../src/db/challengeNonces.js";
import { getCursor, setCursor } from "../src/db/cursor.js";
import { getProcessedEvent, insertProcessedEventIfNew } from "../src/db/processedEvents.js";
import * as schema from "../src/db/schema.js";
import { providerApplications, reviews } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrations.js";
import { processEvent } from "../src/chain/event-worker.js";
import { closeDatabase, fakeChainEvent, openTestDatabase, randomBookingId, seedBooking, seedCategory } from "./helpers.js";

/** 2^127 - 1: the top of the signed i128 range the contract's deposit
 * amount type can hold (AD-7 -- stored and carried as a string, never a
 * float, never a SQLite INTEGER, which cannot hold this without loss). */
const I128_MAX = "170141183460469231731687303715884105727";

test("an i128-max deposit amount is stored and read back as the identical string", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result, { depositAmount: I128_MAX });
    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.depositAmount, I128_MAX);
    assert.equal(typeof booking?.depositAmount, "string");
  } finally {
    closeDatabase(result);
  }
});

test("updateEscrowState touches only escrow_state, never balance_state", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result, { balanceState: "paid_platform" });
    await updateEscrowState(result.db, bookingId, "locked");
    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowState, "locked");
    assert.equal(booking?.balanceState, "paid_platform");
  } finally {
    closeDatabase(result);
  }
});

test("updateBalanceState touches only balance_state, never escrow_state", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    // Route escrow_state through the real single writer (the event worker)
    // rather than calling updateEscrowState directly as a stand-in for it:
    // only chain/event-worker.ts may write escrow_state (AD-1/AD-3), and a
    // test helper that writes it directly is exactly the "test helper that
    // pretends to be [the event worker]" case the spec's Never list rules
    // out. `updateEscrowState touches only escrow_state...` above is the
    // one legitimate exception -- it is db/bookings.ts's own unit test.
    await processEvent(result.db, fakeChainEvent({ bookingId, eventType: "released" }));
    await updateBalanceState(result.db, bookingId, "paid_cash");
    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.balanceState, "paid_cash");
    assert.equal(booking?.escrowState, "released");
  } finally {
    closeDatabase(result);
  }
});

test("updateEscrowState throws for an unknown booking id instead of silently writing nothing", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => updateEscrowState(result.db, randomBookingId(), "locked"), TypeError);
  } finally {
    closeDatabase(result);
  }
});

test("updateBalanceState throws for an unknown booking id instead of silently writing nothing", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => updateBalanceState(result.db, randomBookingId(), "paid_cash"), TypeError);
  } finally {
    closeDatabase(result);
  }
});

test("getCursor is undefined before the worker has ever run", async () => {
  const result = openTestDatabase();
  try {
    assert.equal(await getCursor(result.db), undefined);
  } finally {
    closeDatabase(result);
  }
});

test("setCursor persists and can be updated in place (restart resumes from the latest value)", async () => {
  const result = openTestDatabase();
  try {
    await setCursor(result.db, "cursor-1");
    assert.equal(await getCursor(result.db), "cursor-1");
    await setCursor(result.db, "cursor-2");
    assert.equal(await getCursor(result.db), "cursor-2");
  } finally {
    closeDatabase(result);
  }
});

test("getAnchorJwt is undefined for a wallet with no cached anchor JWT", async () => {
  const result = openTestDatabase();
  try {
    assert.equal(await getAnchorJwt(result.db, "GNOCACHE"), undefined);
  } finally {
    closeDatabase(result);
  }
});

test("upsertAnchorJwt writes a wallet's anchor JWT and getAnchorJwt reads it back", async () => {
  const result = openTestDatabase();
  try {
    await upsertAnchorJwt(result.db, { walletAddress: "GWALLET1", jwt: "jwt-1", expiresAt: 1_000 });
    const row = await getAnchorJwt(result.db, "GWALLET1");
    assert.equal(row?.jwt, "jwt-1");
    assert.equal(row?.expiresAt, 1_000);
  } finally {
    closeDatabase(result);
  }
});

test("upsertAnchorJwt replaces a wallet's cached anchor JWT in place (never a second row)", async () => {
  const result = openTestDatabase();
  try {
    await upsertAnchorJwt(result.db, { walletAddress: "GWALLET1", jwt: "jwt-1", expiresAt: 1_000 });
    await upsertAnchorJwt(result.db, { walletAddress: "GWALLET1", jwt: "jwt-2", expiresAt: 2_000 });
    const row = await getAnchorJwt(result.db, "GWALLET1");
    assert.equal(row?.jwt, "jwt-2");
    assert.equal(row?.expiresAt, 2_000);
  } finally {
    closeDatabase(result);
  }
});

test("redeemChallengeNonceIfUnused returns true for a fresh nonce and false for a replay of the same one", async () => {
  const result = openTestDatabase();
  try {
    const first = await redeemChallengeNonceIfUnused(result.db, "nonce-1", Date.now() + 1_000);
    assert.equal(first, true);
    const replay = await redeemChallengeNonceIfUnused(result.db, "nonce-1", Date.now() + 1_000);
    assert.equal(replay, false);
  } finally {
    closeDatabase(result);
  }
});

test("redeemChallengeNonceIfUnused treats different nonces independently", async () => {
  const result = openTestDatabase();
  try {
    assert.equal(await redeemChallengeNonceIfUnused(result.db, "nonce-a", Date.now() + 1_000), true);
    assert.equal(await redeemChallengeNonceIfUnused(result.db, "nonce-b", Date.now() + 1_000), true);
  } finally {
    closeDatabase(result);
  }
});

test("insertProcessedEventIfNew returns true for a fresh (booking_id, event_type) and false for a replay", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const event = {
      bookingId,
      eventType: "locked",
      amount: "1000000",
      ledger: 1,
      eventId: "evt-1",
      isAnomaly: false,
      processedAt: Date.now(),
    };
    assert.equal(await insertProcessedEventIfNew(result.db, event), true);
    assert.equal(await insertProcessedEventIfNew(result.db, { ...event, eventId: "evt-2" }), false);

    const row = await getProcessedEvent(result.db, bookingId, "locked");
    assert.equal(row?.eventId, "evt-1");
  } finally {
    closeDatabase(result);
  }
});

test("runMigrations adds escrow_contract_id to a bookings table created before Story 2.6 (ALTER, not a no-op CREATE)", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.pragma("foreign_keys = ON");
    // The pre-2.6 DDL: no escrow_contract_id column. `CREATE TABLE IF NOT
    // EXISTS` in migrations.ts is a silent no-op against a table that
    // already exists this way, so only a real ALTER TABLE (guarded by
    // PRAGMA table_info) can bring it up to date.
    sqlite.exec(`CREATE TABLE categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, parent_category_id TEXT
    )`);
    sqlite.exec(`CREATE TABLE provider_profiles (
      id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL UNIQUE, category_id TEXT NOT NULL REFERENCES categories(id),
      bio TEXT NOT NULL DEFAULT '', languages TEXT NOT NULL DEFAULT '[]', session_format TEXT NOT NULL,
      session_length_minutes INTEGER NOT NULL, price_amount TEXT NOT NULL, deposit_rate_bps INTEGER NOT NULL,
      cancellation_window_hours INTEGER NOT NULL, is_approved INTEGER NOT NULL DEFAULT 0,
      verified_session_count INTEGER NOT NULL DEFAULT 0, provider_cancellation_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    sqlite.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY, provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
      client_wallet_address TEXT NOT NULL, token_address TEXT NOT NULL, deposit_amount TEXT NOT NULL,
      balance_amount TEXT NOT NULL DEFAULT '0', cancel_deadline INTEGER NOT NULL, escrow_state TEXT,
      balance_state TEXT NOT NULL DEFAULT 'unpaid', created_at INTEGER NOT NULL
    )`);

    const categoryId = randomUUID();
    sqlite.prepare(`INSERT INTO categories (id, name, slug) VALUES (?, 'Consulting', ?)`).run(categoryId, `consulting-${categoryId}`);
    const providerProfileId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO provider_profiles
          (id, wallet_address, category_id, session_format, session_length_minutes, price_amount, deposit_rate_bps, cancellation_window_hours, created_at)
         VALUES (?, ?, ?, 'video', 50, '10000000', 2000, 24, ?)`,
      )
      .run(providerProfileId, `GPROVIDER${providerProfileId.replace(/-/g, "").toUpperCase()}`, categoryId, Date.now());
    const bookingId = randomBookingId();
    sqlite
      .prepare(
        `INSERT INTO bookings (id, provider_profile_id, client_wallet_address, token_address, deposit_amount, cancel_deadline, created_at)
         VALUES (?, ?, 'GCLIENTPRE26', 'CTOKENPRE26', '1000000', ?, ?)`,
      )
      .run(bookingId, providerProfileId, Math.floor(Date.now() / 1000) + 3600, Date.now());

    // The migration under test: must add the missing column in place,
    // without touching the row already there.
    runMigrations(sqlite);

    const db = drizzle(sqlite, { schema });
    const contractId = "CFAKECONTRACTIDFORMIGRATIONTEST00000000000000000000000";
    await updateEscrowContractId(db, bookingId, contractId);
    const booking = await getBookingById(db, bookingId);
    assert.equal(booking?.escrowContractId, contractId);
    assert.equal(booking?.clientWalletAddress, "GCLIENTPRE26", "the pre-existing row must survive the migration");
  } finally {
    sqlite.close();
  }
});

test("runMigrations adds display_name/title/location to a provider_profiles table created before Story 3.1 (ALTER, not a no-op CREATE)", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.pragma("foreign_keys = ON");
    // The pre-3.1 DDL: no display_name/title/location columns.
    sqlite.exec(`CREATE TABLE categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, parent_category_id TEXT
    )`);
    sqlite.exec(`CREATE TABLE provider_profiles (
      id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL UNIQUE, category_id TEXT NOT NULL REFERENCES categories(id),
      bio TEXT NOT NULL DEFAULT '', languages TEXT NOT NULL DEFAULT '[]', session_format TEXT NOT NULL,
      session_length_minutes INTEGER NOT NULL, price_amount TEXT NOT NULL, deposit_rate_bps INTEGER NOT NULL,
      cancellation_window_hours INTEGER NOT NULL, is_approved INTEGER NOT NULL DEFAULT 0,
      verified_session_count INTEGER NOT NULL DEFAULT 0, provider_cancellation_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    sqlite.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY, provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
      client_wallet_address TEXT NOT NULL, token_address TEXT NOT NULL, deposit_amount TEXT NOT NULL,
      balance_amount TEXT NOT NULL DEFAULT '0', cancel_deadline INTEGER NOT NULL, escrow_state TEXT,
      balance_state TEXT NOT NULL DEFAULT 'unpaid', created_at INTEGER NOT NULL
    )`);

    const categoryId = randomUUID();
    sqlite.prepare(`INSERT INTO categories (id, name, slug) VALUES (?, 'Consulting', ?)`).run(categoryId, `consulting-${categoryId}`);
    const providerProfileId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO provider_profiles
          (id, wallet_address, category_id, session_format, session_length_minutes, price_amount, deposit_rate_bps, cancellation_window_hours, created_at)
         VALUES (?, ?, ?, 'video', 50, '10000000', 2000, 24, ?)`,
      )
      .run(providerProfileId, `GPROVIDERPRE31${providerProfileId.replace(/-/g, "").toUpperCase()}`, categoryId, Date.now());

    // The migration under test: must add the three missing columns in
    // place, without touching the row already there.
    runMigrations(sqlite);

    const db = drizzle(sqlite, { schema });
    const profile = await getProviderProfileById(db, providerProfileId);
    assert.equal(profile?.displayName, "", "a pre-existing row gets the column's default, not an error");
    assert.equal(profile?.title, "");
    assert.equal(profile?.location, "");
    assert.equal(profile?.sessionFormat, "video", "the pre-existing row must survive the migration");

    await updateProviderProfileRules(db, providerProfileId, {
      priceAmount: "20000000",
      depositRateBps: 3000,
      cancellationWindowHours: 48,
    });
    const updated = await getProviderProfileById(db, providerProfileId);
    assert.equal(updated?.priceAmount, "20000000");
  } finally {
    sqlite.close();
  }
});

test("runMigrations creates availability_slots for a database created before Story 3.1", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.pragma("foreign_keys = ON");
    // No availability_slots table at all -- simulates a database from
    // before this story existed.
    sqlite.exec(`CREATE TABLE categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, parent_category_id TEXT
    )`);
    runMigrations(sqlite);
    const columns = sqlite.prepare(`PRAGMA table_info(availability_slots)`).all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "starts_at"));
  } finally {
    sqlite.close();
  }
});

test("runMigrations adds slot_id/hold_expires_at/escrow_deploy_xdr to a bookings table created before Story 3.4 (ALTER, not a no-op CREATE)", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.pragma("foreign_keys = ON");
    // The pre-3.4 DDL: no slot_id/hold_expires_at/escrow_deploy_xdr columns
    // (Story 2.6's own shape, escrow_contract_id included).
    sqlite.exec(`CREATE TABLE categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, parent_category_id TEXT
    )`);
    sqlite.exec(`CREATE TABLE provider_profiles (
      id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL UNIQUE, category_id TEXT NOT NULL REFERENCES categories(id),
      display_name TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '', languages TEXT NOT NULL DEFAULT '[]', session_format TEXT NOT NULL,
      session_length_minutes INTEGER NOT NULL, price_amount TEXT NOT NULL, deposit_rate_bps INTEGER NOT NULL,
      cancellation_window_hours INTEGER NOT NULL, is_approved INTEGER NOT NULL DEFAULT 0,
      verified_session_count INTEGER NOT NULL DEFAULT 0, provider_cancellation_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    sqlite.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY, provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
      client_wallet_address TEXT NOT NULL, token_address TEXT NOT NULL, deposit_amount TEXT NOT NULL,
      balance_amount TEXT NOT NULL DEFAULT '0', cancel_deadline INTEGER NOT NULL, escrow_state TEXT,
      balance_state TEXT NOT NULL DEFAULT 'unpaid', escrow_contract_id TEXT, created_at INTEGER NOT NULL
    )`);

    const categoryId = randomUUID();
    sqlite.prepare(`INSERT INTO categories (id, name, slug) VALUES (?, 'Consulting', ?)`).run(categoryId, `consulting-${categoryId}`);
    const providerProfileId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO provider_profiles
          (id, wallet_address, category_id, session_format, session_length_minutes, price_amount, deposit_rate_bps, cancellation_window_hours, created_at)
         VALUES (?, ?, ?, 'video', 50, '10000000', 2000, 24, ?)`,
      )
      .run(providerProfileId, `GPROVIDERPRE34${providerProfileId.replace(/-/g, "").toUpperCase()}`, categoryId, Date.now());
    const bookingId = randomBookingId();
    sqlite
      .prepare(
        `INSERT INTO bookings (id, provider_profile_id, client_wallet_address, token_address, deposit_amount, cancel_deadline, created_at)
         VALUES (?, ?, 'GCLIENTPRE34', 'CTOKENPRE34', '1000000', ?, ?)`,
      )
      .run(bookingId, providerProfileId, Math.floor(Date.now() / 1000) + 3600, Date.now());

    // The migration under test: must add the three missing columns in
    // place, without touching the row already there.
    runMigrations(sqlite);

    const columns = sqlite.prepare(`PRAGMA table_info(bookings)`).all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "slot_id"));
    assert.ok(columns.some((column) => column.name === "hold_expires_at"));
    assert.ok(columns.some((column) => column.name === "escrow_deploy_xdr"));

    const db = drizzle(sqlite, { schema });
    const booking = await getBookingById(db, bookingId);
    assert.equal(booking?.slotId, null);
    assert.equal(booking?.holdExpiresAt, null);
    assert.equal(booking?.escrowDeployXdr, null);
    assert.equal(booking?.clientWalletAddress, "GCLIENTPRE34", "the pre-existing row must survive the migration");
  } finally {
    sqlite.close();
  }
});

test("runMigrations adds Story 3.6's five action tx-hash columns to a bookings table created before it, and creates escrow_dispute_openings (ALTER, not a no-op CREATE)", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.pragma("foreign_keys = ON");
    // The pre-3.6 DDL: Story 3.4's own shape (escrow_deploy_xdr and
    // friends), but none of Story 3.6's five action tx-hash columns.
    sqlite.exec(`CREATE TABLE categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, parent_category_id TEXT
    )`);
    sqlite.exec(`CREATE TABLE provider_profiles (
      id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL UNIQUE, category_id TEXT NOT NULL REFERENCES categories(id),
      display_name TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '', languages TEXT NOT NULL DEFAULT '[]', session_format TEXT NOT NULL,
      session_length_minutes INTEGER NOT NULL, price_amount TEXT NOT NULL, deposit_rate_bps INTEGER NOT NULL,
      cancellation_window_hours INTEGER NOT NULL, is_approved INTEGER NOT NULL DEFAULT 0,
      verified_session_count INTEGER NOT NULL DEFAULT 0, provider_cancellation_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    sqlite.exec(`CREATE TABLE availability_slots (
      id TEXT PRIMARY KEY, provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
      starts_at INTEGER NOT NULL, withdrawn_at INTEGER, created_at INTEGER NOT NULL,
      UNIQUE (provider_profile_id, starts_at)
    )`);
    sqlite.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY, provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
      client_wallet_address TEXT NOT NULL, token_address TEXT NOT NULL, deposit_amount TEXT NOT NULL,
      balance_amount TEXT NOT NULL DEFAULT '0', cancel_deadline INTEGER NOT NULL, escrow_state TEXT,
      balance_state TEXT NOT NULL DEFAULT 'unpaid', escrow_contract_id TEXT, slot_id TEXT REFERENCES availability_slots(id),
      hold_expires_at INTEGER, escrow_deploy_xdr TEXT, escrow_deploy_tx_hash TEXT, escrow_fund_tx_hash TEXT,
      deploy_submitted_at INTEGER, created_at INTEGER NOT NULL
    )`);

    const categoryId = randomUUID();
    sqlite.prepare(`INSERT INTO categories (id, name, slug) VALUES (?, 'Consulting', ?)`).run(categoryId, `consulting-${categoryId}`);
    const providerProfileId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO provider_profiles
          (id, wallet_address, category_id, session_format, session_length_minutes, price_amount, deposit_rate_bps, cancellation_window_hours, created_at)
         VALUES (?, ?, ?, 'video', 50, '10000000', 2000, 24, ?)`,
      )
      .run(providerProfileId, `GPROVIDERPRE36${providerProfileId.replace(/-/g, "").toUpperCase()}`, categoryId, Date.now());
    const bookingId = randomBookingId();
    sqlite
      .prepare(
        `INSERT INTO bookings (id, provider_profile_id, client_wallet_address, token_address, deposit_amount, cancel_deadline, created_at)
         VALUES (?, ?, 'GCLIENTPRE36', 'CTOKENPRE36', '1000000', ?, ?)`,
      )
      .run(bookingId, providerProfileId, Math.floor(Date.now() / 1000) + 3600, Date.now());

    // The migration under test: must add the five missing columns in place
    // (without touching the row already there) and create the new table.
    runMigrations(sqlite);

    const columns = sqlite.prepare(`PRAGMA table_info(bookings)`).all() as Array<{ name: string }>;
    for (const column of ["escrow_complete_tx_hash", "escrow_approve_tx_hash", "escrow_release_tx_hash", "escrow_dispute_tx_hash", "escrow_resolve_tx_hash"]) {
      assert.ok(columns.some((c) => c.name === column), `expected ${column} to exist after migration`);
    }
    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'escrow_dispute_openings'`).all();
    assert.equal(tables.length, 1, "escrow_dispute_openings must be created");

    const db = drizzle(sqlite, { schema });
    const booking = await getBookingById(db, bookingId);
    assert.equal(booking?.escrowCompleteTxHash, null);
    assert.equal(booking?.escrowApproveTxHash, null);
    assert.equal(booking?.escrowReleaseTxHash, null);
    assert.equal(booking?.escrowDisputeTxHash, null);
    assert.equal(booking?.escrowResolveTxHash, null);
    assert.equal(booking?.clientWalletAddress, "GCLIENTPRE36", "the pre-existing row must survive the migration");
  } finally {
    sqlite.close();
  }
});

// The two tests below insert and select through the Drizzle table objects
// directly, for tables nothing else in the codebase reads or writes yet
// (provider_applications, reviews -- future stories' job). `migrations.ts`
// is hand-written DDL, an untyped string TypeScript never checks against
// `schema.ts`; only a real SQLite round trip through both declarations
// together can catch them drifting apart (a renamed or dropped DDL column
// leaves typecheck clean and would otherwise ship silently).

test("provider_applications round-trips through the Drizzle schema (DDL agrees with schema.ts)", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result);
    const id = randomUUID();
    await result.db.insert(providerApplications).values({
      id,
      walletAddress: "GAPPLICANTWALLET",
      name: "Jane Professional",
      title: "Licensed Therapist",
      categoryId,
      serviceDescription: "1:1 sessions",
      sessionFormat: "video",
      sessionLengthMinutes: 50,
      sessionPriceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
      createdAt: Date.now(),
    });

    const rows = await result.db.select().from(providerApplications).where(eq(providerApplications.id, id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.walletAddress, "GAPPLICANTWALLET");
    assert.equal(rows[0]?.categoryId, categoryId);
    assert.equal(rows[0]?.state, "pending");
  } finally {
    closeDatabase(result);
  }
});

test("reviews round-trips through the Drizzle schema (DDL agrees with schema.ts)", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const id = randomUUID();
    await result.db.insert(reviews).values({
      id,
      bookingId,
      clientWalletAddress: "GCLIENTREVIEWWALLET",
      rating: 5,
      comment: "Great session",
      createdAt: Date.now(),
    });

    const rows = await result.db.select().from(reviews).where(eq(reviews.id, id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.bookingId, bookingId);
    assert.equal(rows[0]?.rating, 5);
    assert.equal(rows[0]?.comment, "Great session");
  } finally {
    closeDatabase(result);
  }
});

test("escrow_dispute_openings round-trips through the Drizzle schema, including a null suggested_outcome (DDL agrees with schema.ts)", async () => {
  const result = openTestDatabase();
  try {
    const { escrowDisputeOpenings } = await import("../src/db/schema.js");
    const bookingId = await seedBooking(result);
    await result.db.insert(escrowDisputeOpenings).values({
      bookingId,
      contractId: "CFAKECONTRACT",
      openedByWallet: "GOPENERWALLET",
      reason: "disagreement",
      suggestedOutcome: null,
      txHash: "dispute-tx-hash",
      openedAt: Date.now(),
    });

    const rows = await result.db.select().from(escrowDisputeOpenings).where(eq(escrowDisputeOpenings.bookingId, bookingId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.reason, "disagreement");
    assert.equal(rows[0]?.suggestedOutcome, null);
    assert.equal(rows[0]?.openedByWallet, "GOPENERWALLET");
  } finally {
    closeDatabase(result);
  }
});
