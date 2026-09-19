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
  `CREATE TABLE IF NOT EXISTS availability_slots (
    id TEXT PRIMARY KEY,
    provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
    starts_at INTEGER NOT NULL,
    withdrawn_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (provider_profile_id, starts_at)
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
    escrow_contract_id TEXT,
    slot_id TEXT REFERENCES availability_slots(id),
    hold_expires_at INTEGER,
    escrow_deploy_xdr TEXT,
    escrow_deploy_tx_hash TEXT,
    escrow_fund_tx_hash TEXT,
    deploy_submitted_at INTEGER,
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
  `CREATE TABLE IF NOT EXISTS used_challenge_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL
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
  `CREATE TABLE IF NOT EXISTS escrow_processed_events (
    booking_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    lifecycle_action TEXT NOT NULL,
    amount TEXT NOT NULL,
    ledger_seq TEXT NOT NULL,
    is_anomaly INTEGER NOT NULL DEFAULT 0,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (contract_id, lifecycle_action)
  )`,
  `CREATE TABLE IF NOT EXISTS escrow_reconciler_watermarks (
    contract_id TEXT PRIMARY KEY,
    last_ledger_seq TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS escrow_dispute_resolutions (
    booking_id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    decided_at INTEGER NOT NULL
  )`,
];

/** `true` when `table` already has a column named `column` -- `PRAGMA
 * table_info` is SQLite's own way to ask, and the only reliable one: a
 * `CREATE TABLE IF NOT EXISTS` is a silent no-op against a table that
 * already exists, so a column added to `schema.ts` after a database was
 * first created needs its own `ALTER TABLE`, guarded by this check so
 * re-running it against an already-migrated database stays a no-op too. */
function hasColumn(sqlite: Database, table: string, column: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((existing) => existing.name === column);
}

/** Applies every `CREATE TABLE IF NOT EXISTS` statement, in order (later
 * tables reference earlier ones via `REFERENCES`), then every column added
 * to an existing table since this database might first have been created
 * -- `bookings.escrow_contract_id` (Story 2.6): a database created before
 * this column existed has a `bookings` table the `CREATE TABLE IF NOT
 * EXISTS` above never touches, so without this every query that reads or
 * writes `escrow_contract_id` against it fails with "no such column".
 * Story 3.1 adds three more this same way: `provider_profiles.display_name`,
 * `.title` and `.location`, all `NOT NULL DEFAULT ''` so a pre-existing row
 * keeps working (it just shows an empty name/title/location until its
 * owner fills the rules form in). */
export function runMigrations(sqlite: Database): void {
  sqlite.pragma("foreign_keys = ON");
  for (const statement of STATEMENTS) {
    sqlite.exec(statement);
  }
  if (!hasColumn(sqlite, "bookings", "escrow_contract_id")) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN escrow_contract_id TEXT`);
  }
  if (!hasColumn(sqlite, "provider_profiles", "display_name")) {
    sqlite.exec(`ALTER TABLE provider_profiles ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn(sqlite, "provider_profiles", "title")) {
    sqlite.exec(`ALTER TABLE provider_profiles ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
  }
  if (!hasColumn(sqlite, "provider_profiles", "location")) {
    sqlite.exec(`ALTER TABLE provider_profiles ADD COLUMN location TEXT NOT NULL DEFAULT ''`);
  }
  // Story 3.4: the AD-13 slot hold's own columns -- nullable, since a
  // database created before this story has `bookings` rows that never had a
  // slot or a hold expiry (and never will retroactively).
  if (!hasColumn(sqlite, "bookings", "slot_id")) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN slot_id TEXT REFERENCES availability_slots(id)`);
  }
  if (!hasColumn(sqlite, "bookings", "hold_expires_at")) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN hold_expires_at INTEGER`);
  }
  if (!hasColumn(sqlite, "bookings", "escrow_deploy_xdr")) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN escrow_deploy_xdr TEXT`);
  }
  // Review follow-up (Story 3.4): the deploy/fund txHash columns
  // `submitSignedTransaction` matches a signed envelope's own computed hash
  // against, and the timestamp marking a deploy as actually submitted.
  if (!hasColumn(sqlite, "bookings", "escrow_deploy_tx_hash")) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN escrow_deploy_tx_hash TEXT`);
  }
  if (!hasColumn(sqlite, "bookings", "escrow_fund_tx_hash")) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN escrow_fund_tx_hash TEXT`);
  }
  if (!hasColumn(sqlite, "bookings", "deploy_submitted_at")) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN deploy_submitted_at INTEGER`);
  }
  // Review follow-up (Story 3.4): a future slot a booking still references
  // (actively or not) can never be hard-deleted once foreign_keys=ON --
  // `withdrawn_at` lets `replaceFutureSlots` mark it removed instead.
  if (!hasColumn(sqlite, "availability_slots", "withdrawn_at")) {
    sqlite.exec(`ALTER TABLE availability_slots ADD COLUMN withdrawn_at INTEGER`);
  }
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_bookings_slot_id ON bookings(slot_id)`);
}
