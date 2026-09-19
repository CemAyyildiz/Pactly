/**
 * The schema's migration. This workspace has no `drizzle-kit`, so this is
 * hand-written DDL rather than a generated one -- every statement mirrors a
 * table in `schema.ts` column for column, and both must change together.
 *
 * Every statement is `IF NOT EXISTS`, so running this against an
 * already-migrated database is a no-op: `openDatabase` (`client.ts`) calls
 * it on every open rather than tracking a separate "have I migrated"
 * marker, which is what keeps a fresh temporary test database and the real
 * one at `config.databasePath` set up the same way.
 */
import type { Database } from "better-sqlite3";

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    parent_category_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS provider_applications (
    id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id),
    service_description TEXT NOT NULL,
    session_format TEXT NOT NULL,
    session_length_minutes INTEGER NOT NULL,
    session_price_amount TEXT NOT NULL,
    deposit_rate_bps INTEGER NOT NULL,
    cancellation_window_hours INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    decision_at INTEGER,
    decision_by_wallet TEXT,
    rejection_reason TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL UNIQUE,
    category_id TEXT NOT NULL REFERENCES categories(id),
    bio TEXT NOT NULL DEFAULT '',
    languages TEXT NOT NULL DEFAULT '[]',
    session_format TEXT NOT NULL,
    session_length_minutes INTEGER NOT NULL,
    price_amount TEXT NOT NULL,
    deposit_rate_bps INTEGER NOT NULL,
    cancellation_window_hours INTEGER NOT NULL,
    is_approved INTEGER NOT NULL DEFAULT 0,
    verified_session_count INTEGER NOT NULL DEFAULT 0,
    provider_cancellation_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
    client_wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    deposit_amount TEXT NOT NULL,
    balance_amount TEXT NOT NULL DEFAULT '0',
    cancel_deadline INTEGER NOT NULL,
    escrow_state TEXT,
    balance_state TEXT NOT NULL DEFAULT 'unpaid',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
    client_wallet_address TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS anchor_jwts (
    wallet_address TEXT PRIMARY KEY,
    jwt TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_worker_state (
    id INTEGER PRIMARY KEY,
    cursor TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS processed_events (
    booking_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    amount TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    is_anomaly INTEGER NOT NULL DEFAULT 0,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (booking_id, event_type)
  )`,
];

/** Applies every `CREATE TABLE IF NOT EXISTS` statement, in order (later
 * tables reference earlier ones via `REFERENCES`). */
export function runMigrations(sqlite: Database): void {
  sqlite.pragma("foreign_keys = ON");
  for (const statement of STATEMENTS) {
    sqlite.exec(statement);
  }
}
