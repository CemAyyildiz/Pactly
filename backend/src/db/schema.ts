/**
 * The Drizzle schema: the mirror for everything the chain does not hold.
 *
 * `bookings` carries the two independent state fields AD-3 requires:
 * `escrowState` (locked/released/refunded), written only by the event worker
 * in `../chain/event-worker.ts`, and `balanceState` (unpaid/paid_platform/
 * paid_cash), written only by the backend's own services. Nothing here
 * merges them into one column.
 *
 * All amounts are stored as `text`, carrying an integer string in the
 * asset's smallest unit (AD-7) -- never a float, never a SQLite `INTEGER`,
 * which cannot hold a full `i128` without losing precision.
 *
 * `migrations.ts` is this schema's hand-written DDL (no drizzle-kit in this
 * workspace); a column added here must be added there too.
 */
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

/** Initial set: therapy and wellbeing, education and lessons, consulting,
 * fitness and beauty (PRD Data Model Additions). */
export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  parentCategoryId: text("parent_category_id"),
});

export const PROVIDER_APPLICATION_STATES = ["pending", "approved", "rejected"] as const;
export type ProviderApplicationState = (typeof PROVIDER_APPLICATION_STATES)[number];

/** A professional's application to join the marketplace (Story 4.1). The
 * `provider_profiles` row a decision creates is a separate concern -- this
 * table only ever records the application and its own state. */
export const providerApplications = sqliteTable("provider_applications", {
  id: text("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  categoryId: text("category_id")
    .notNull()
    .references(() => categories.id),
  serviceDescription: text("service_description").notNull(),
  sessionFormat: text("session_format").notNull(),
  sessionLengthMinutes: integer("session_length_minutes").notNull(),
  /** Integer string, smallest unit (AD-7). */
  sessionPriceAmount: text("session_price_amount").notNull(),
  /** Deposit rate in basis points of the session price (integer, AD-7). */
  depositRateBps: integer("deposit_rate_bps").notNull(),
  cancellationWindowHours: integer("cancellation_window_hours").notNull(),
  state: text("state", { enum: PROVIDER_APPLICATION_STATES }).notNull().default("pending"),
  decisionAt: integer("decision_at"),
  decisionByWallet: text("decision_by_wallet"),
  rejectionReason: text("rejection_reason"),
  createdAt: integer("created_at").notNull(),
});

/** A listed, bookable professional. Visible on the marketplace only once
 * `isApproved` is set (Story 4.1/4.2's job, not this story's). */
export const providerProfiles = sqliteTable("provider_profiles", {
  id: text("id").primaryKey(),
  walletAddress: text("wallet_address").notNull().unique(),
  categoryId: text("category_id")
    .notNull()
    .references(() => categories.id),
  bio: text("bio").notNull().default(""),
  /** JSON-encoded array of language codes/names. */
  languages: text("languages").notNull().default("[]"),
  sessionFormat: text("session_format").notNull(),
  sessionLengthMinutes: integer("session_length_minutes").notNull(),
  /** Integer string, smallest unit (AD-7). */
  priceAmount: text("price_amount").notNull(),
  depositRateBps: integer("deposit_rate_bps").notNull(),
  cancellationWindowHours: integer("cancellation_window_hours").notNull(),
  isApproved: integer("is_approved", { mode: "boolean" }).notNull().default(false),
  /** Increases only on the chain's `released` event (FR20); never written
   * by hand outside the event worker's own bookkeeping. */
  verifiedSessionCount: integer("verified_session_count").notNull().default(0),
  /** Increases only on the chain's `cancelled` event (FR23). */
  providerCancellationCount: integer("provider_cancellation_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

/** Booking states the contract can never produce. `escrowState` is `null`
 * until the event worker processes the booking's first event -- the row is
 * written before the chain call (AD-13's hold), so it exists before any
 * event about it can arrive. */
export const ESCROW_STATES = ["locked", "released", "refunded"] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

export const BALANCE_STATES = ["unpaid", "paid_platform", "paid_cash"] as const;
export type BalanceState = (typeof BALANCE_STATES)[number];

/**
 * A booking, matched to the on-chain `booking_id` (AD-13's ULID, stored
 * here as 32 lowercase hex characters -- the same 16 bytes the contract's
 * `BytesN<16>` holds).
 *
 * AD-1/AD-3: `escrowState` is written **only** by the event worker
 * (`../chain/event-worker.ts`); every other writer of this row, including
 * every service in `../services/`, must leave that column alone.
 */
export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  providerProfileId: text("provider_profile_id")
    .notNull()
    .references(() => providerProfiles.id),
  clientWalletAddress: text("client_wallet_address").notNull(),
  /** The token contract the deposit is denominated in (C... or G...). */
  tokenAddress: text("token_address").notNull(),
  /** Integer string, smallest unit (AD-7); the amount locked on chain. */
  depositAmount: text("deposit_amount").notNull(),
  /** Integer string, smallest unit (AD-7); the remainder of the session
   * price, settled off the escrow contract (Story 3.7). */
  balanceAmount: text("balance_amount").notNull().default("0"),
  /** UTC epoch seconds -- the same unit and value passed to `create_booking`. */
  cancelDeadline: integer("cancel_deadline").notNull(),
  /** `null` until the event worker records this booking's first event. */
  escrowState: text("escrow_state", { enum: ESCROW_STATES }),
  balanceState: text("balance_state", { enum: BALANCE_STATES }).notNull().default("unpaid"),
  createdAt: integer("created_at").notNull(),
});

/** At most one review per booking, and only for a booking whose deposit was
 * released -- enforced by the service that writes this table (Story 4.4),
 * not by this schema. */
export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id")
    .notNull()
    .unique()
    .references(() => bookings.id),
  clientWalletAddress: text("client_wallet_address").notNull(),
  rating: integer("rating").notNull(),
  comment: text("comment").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});

/**
 * The anchor's JWT cache (Story 2.1): one row per wallet, keyed by wallet
 * address, so the anchor's real SEP-10 exchange is not re-run on every call
 * that needs it (`../anchor/sep10.ts` is expensive and hits a third
 * party; `../services/auth.ts` reads this first and only refreshes once
 * `expiresAt` has actually passed). Never read by any route directly, and
 * never present in this backend's own HTTP responses -- only the Pactly JWT
 * goes to the caller (AD-5).
 */
export const anchorJwts = sqliteTable("anchor_jwts", {
  walletAddress: text("wallet_address").primaryKey(),
  jwt: text("jwt").notNull(),
  /** Epoch milliseconds, decoded from the anchor's own JWT `exp` claim. */
  expiresAt: integer("expires_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * The event worker's own bookkeeping (AD-9): a single row holding the last
 * processed RPC events cursor. `id` is always `1` -- this table never holds
 * more than one row, so "the stored cursor" needs no further lookup key.
 */
export const eventWorkerState = sqliteTable("event_worker_state", {
  id: integer("id").primaryKey(),
  cursor: text("cursor"),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * The dedupe ledger AD-9 requires: one row per `(booking_id, event_type)`
 * ever applied. A batch that replays an already-processed pair inserts
 * nothing here and changes nothing else -- see
 * `../chain/event-worker.ts`'s `processEvent`.
 */
export const processedEvents = sqliteTable(
  "processed_events",
  {
    bookingId: text("booking_id").notNull(),
    /** `locked` | `released` | `refunded` | `cancelled` | `forfeited` --
     * kept distinct from `escrowState` on purpose: `released` and
     * `forfeited` share a state but not a meaning (AD-4). */
    eventType: text("event_type").notNull(),
    /** Integer string, smallest unit (AD-7), round-tripped exactly. */
    amount: text("amount").notNull(),
    ledger: integer("ledger").notNull(),
    /** The RPC event's own id; kept for traceability, not for dedup --
     * `(bookingId, eventType)` is the dedupe key. */
    eventId: text("event_id").notNull(),
    /** Set when the booking id had no matching row -- surfaced as an
     * anomaly (the I/O matrix's "unknown booking id" row) rather than
     * inventing one. */
    isAnomaly: integer("is_anomaly", { mode: "boolean" }).notNull().default(false),
    processedAt: integer("processed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.bookingId, table.eventType] })],
);
