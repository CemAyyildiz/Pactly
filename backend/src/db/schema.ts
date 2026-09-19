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
import { sqliteTable, text, integer, primaryKey, unique } from "drizzle-orm/sqlite-core";

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
  /** Story 3.1: the name a card/profile shows. Defaults to `''` only for a
   * row created before this story -- a real profile always sets it. */
  displayName: text("display_name").notNull().default(""),
  /** Story 3.1: a short professional title, e.g. "Clinical psychologist". */
  title: text("title").notNull().default(""),
  /** Story 3.1: free-text location shown on the card (no geocoding in this
   * story -- Istanbul strings for the demo seed). */
  location: text("location").notNull().default(""),
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

/**
 * Story 3.1: a concrete, bookable slot (architecture ERD:
 * `PROVIDER_PROFILE ||--o{ AVAILABILITY_SLOT`) -- a specific start time, not
 * a recurring rule, because Story 3.4 must hold and consume exactly one row
 * (see the story's own Design Notes, "Why concrete slots, not weekly
 * rules"). `startsAt` is UTC epoch seconds; the slot lasts the owning
 * profile's own `sessionLengthMinutes`. The unique pair keeps
 * `services/availability.ts`'s replace-all-future save idempotent under a
 * retry: saving the same set twice can never produce two rows for the same
 * start time.
 */
export const availabilitySlots = sqliteTable(
  "availability_slots",
  {
    id: text("id").primaryKey(),
    providerProfileId: text("provider_profile_id")
      .notNull()
      .references(() => providerProfiles.id),
    startsAt: integer("starts_at").notNull(),
    /** Set when `replaceFutureSlots` would otherwise need to delete this
     * row but cannot: a booking (active or not) still references it via
     * `bookings.slot_id`, and `foreign_keys=ON` refuses the delete. A
     * withdrawn slot is excluded from every open/public/card listing, the
     * same as a deleted one would be, and re-adding the same start time
     * clears this back to `null` rather than inserting a second row for
     * it (the unique pair below still names one row per start time). */
    withdrawnAt: integer("withdrawn_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [unique().on(table.providerProfileId, table.startsAt)],
);

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
  /**
   * Story 2.6: the Trustless Work escrow's predicted `contractId`, persisted
   * by `services/booking.ts`'s `lockDeposit` the moment the deploy XDR is
   * built -- before it is ever signed or submitted. This is the anti-forgery
   * boundary AC4 requires (amended 2026-09-19): the reconciler only ever
   * polls `contractId`s that appear here, never escrows discovered by their
   * own self-reported `engagementId` (anyone can deploy an escrow naming any
   * `engagementId`, so trusting that field alone would let a third party's
   * escrow move this booking to `locked`). `null` until `lockDeposit` runs,
   * then written once: `lockDeposit` refuses to deploy again, because the
   * earlier deploy may already have landed and been funded.
   */
  escrowContractId: text("escrow_contract_id"),
  /**
   * Story 3.4: the AD-13 slot hold's own slot (3.1's `availability_slots`).
   * `null` only for a booking inserted before this column existed (Story
   * 2.6-era tests and rows) -- every booking `holdSlot` creates from here on
   * always sets this. This is the join a slot's "is it actively held or
   * locked" check reads (`getReconcilableBookings`'s sibling,
   * `insertBookingHoldIfSlotFree`): at most one booking per `slotId` may be
   * "active" (a non-expired hold, or a non-null `escrowState`) at a time.
   */
  slotId: text("slot_id").references(() => availabilitySlots.id),
  /**
   * Story 3.4 (AD-13): the hold's own 10-minute expiry, UTC epoch seconds.
   * `null` for a pre-3.4 booking. Once this passes with `escrowState` still
   * `null`, the slot is holdable again (the row itself is kept -- see the
   * story's own Design Notes, "Why expired holds keep their row"). Lock and
   * fund both refuse once this has passed and `escrowState` is still `null`
   * (`409 HOLD_EXPIRED`); submit does not check this, since a transaction
   * the client already signed must still be allowed to land.
   */
  holdExpiresAt: integer("hold_expires_at"),
  /**
   * Story 3.4: the unsigned deploy XDR `lockDeposit` built for the
   * currently-persisted `escrowContractId`, stored so a retried `lock` call
   * (after a declined wallet signature) returns the exact same XDR and
   * `contractId` rather than building a second, competing escrow for the
   * same booking (Design Notes: "Why retry reuses the stored deploy XDR").
   * Cleared only on an explicit `rebuild: true` request, and only while no
   * deploy has been submitted yet and `escrowState` is still `null`.
   */
  escrowDeployXdr: text("escrow_deploy_xdr"),
  /** The Trustless Work-returned `txHash` for the currently-persisted
   * deploy XDR -- `submitSignedTransaction` decodes whatever signed
   * envelope it is handed, computes its own hash, and relays it only when
   * that hash matches this column (or `escrowFundTxHash` below); this is
   * what stops `submit` from relaying a signed transaction for a *different*
   * booking's escrow. */
  escrowDeployTxHash: text("escrow_deploy_tx_hash"),
  /** The Trustless Work-returned `txHash` for the most recently built fund
   * XDR -- overwritten every time `fundDeposit` builds one (unlike the
   * deploy XDR, funding is not write-once, so only the latest build is
   * ever the one worth signing). */
  escrowFundTxHash: text("escrow_fund_tx_hash"),
  /** Set once a signed deploy transaction whose hash matches
   * `escrowDeployTxHash` has been successfully relayed via `submit` --
   * `fundDeposit` refuses until this is set (building a fund transaction
   * against a contract that may not exist on chain yet is unverified), and
   * `lockDeposit`'s retry path returns `{deployed: true}` once it is,
   * skipping straight to fund with no XDR to sign again. Setting this also
   * extends `holdExpiresAt` to ten minutes from that moment, since the
   * client has now committed a real signature and needs time to complete
   * funding. UTC epoch seconds. */
  deploySubmittedAt: integer("deploy_submitted_at"),
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
 * Single-use enforcement for Pactly's own SEP-10-shaped challenge (Story
 * 2.1 patch round -- a live HTTP probe showed the same signed challenge
 * could be replayed for unlimited fresh Pactly JWTs). `nonce` is the
 * challenge's own `manage_data` value, unique per issued challenge;
 * `../auth/challenge.ts` records one row here the first time a challenge
 * verifies successfully, and refuses a second submission of the same
 * nonce. `expiresAt` mirrors the challenge's own timebounds so a cleanup
 * job (not yet needed at this scale) would know what is safe to prune.
 */
export const usedChallengeNonces = sqliteTable("used_challenge_nonces", {
  nonce: text("nonce").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at").notNull(),
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

/**
 * Story 2.6's own reconciler dedupe ledger (amended 2026-09-19): the
 * reconciler no longer discovers events off `EscrowEvent.kind` (the SDK
 * defines no fixed vocabulary for it -- see the reconciler's own top doc
 * comment); it derives a lifecycle transition from an `EscrowSummary`
 * read-model row's own fields (`status`, `balance`, `snapshot.dispute`,
 * `snapshot.released`, milestone approvals). The dedupe key changes to
 * `(contractId, lifecycleAction)` -- a transition either happened for this
 * escrow or it did not; there is no per-transaction identity on the
 * read-model row to key on the way `processedEvents.eventType` could.
 * `lifecycleAction` is one of `EscrowLifecycleAction`
 * (`../escrow/trustless-work/reconciler.ts`): `funded` | `approved` |
 * `disputed` | `released` | `resolved` -- `resolved` is kept distinct from
 * `released` so `getEscrowLifecycle` can tell "the happy path released"
 * apart from "a dispute was resolved" for Epic 3's finer UX labels
 * (Design Notes: "Why lifecycle rows are finer than escrow_state").
 */
export const escrowProcessedEvents = sqliteTable(
  "escrow_processed_events",
  {
    bookingId: text("booking_id").notNull(),
    /** The Trustless Work escrow's own identity (a Soroban `C...`) -- half
     * of the dedupe key. */
    contractId: text("contract_id").notNull(),
    lifecycleAction: text("lifecycle_action").notNull(),
    /** Integer string, smallest unit (AD-7), best-effort from the
     * read-model row's own `balance` at the time this transition was
     * derived -- never the SDK's own human-decimal string (see the
     * reconciler's own amount-conversion note). */
    amount: text("amount").notNull(),
    /** The escrow's own `lastLedgerSeq` at the time this transition was
     * derived, kept as the string it arrives as (Trustless Work's
     * read-model uses strings for ledger sequence numbers, not a
     * JS-safe integer) -- traceability only; the watermark that actually
     * gates re-processing lives in `escrowReconcilerWatermarks` below. */
    ledgerSeq: text("ledger_seq").notNull(),
    isAnomaly: integer("is_anomaly", { mode: "boolean" }).notNull().default(false),
    processedAt: integer("processed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.contractId, table.lifecycleAction] })],
);

/**
 * The reconciler's per-escrow restart watermark (AC4, amended 2026-09-19):
 * one row per `contractId` this backend has ever polled, holding the
 * highest `EscrowSummary.lastLedgerSeq` seen for it. Replaces a single
 * global cursor (Story 2.6's first, pre-amendment attempt) because the
 * reconciler no longer scans one global event stream -- it polls a
 * `contractIds` list rebuilt fresh from `bookings.escrow_contract_id` on
 * every run, and a restart must skip only the escrow rows it has already
 * looked at, not resume some unrelated single position.
 */
export const escrowReconcilerWatermarks = sqliteTable("escrow_reconciler_watermarks", {
  contractId: text("contract_id").primaryKey(),
  lastLedgerSeq: text("last_ledger_seq").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const DISPUTE_OUTCOMES = ["refund-client", "pay-provider"] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

/**
 * Pactly's own dispute-resolution decision (Design Notes: "Why the
 * resolution decision is recorded with its txHash"), one row per booking
 * (at most one dispute resolution per booking, ever -- a booking's deposit
 * can only be allocated once). Written by `services/booking.ts`'s
 * `resolveBookingDispute` the moment the unsigned resolve-dispute XDR is
 * built; read by the reconciler once the chain shows the dispute resolved
 * and the balance at zero, to learn which of `refunded`/`released` that
 * evidence actually means -- the read-model shows *that* a dispute
 * resolved, never *to whom* the money went (AC7: never an outcome a
 * deadline infers on its own).
 */
export const escrowDisputeResolutions = sqliteTable("escrow_dispute_resolutions", {
  bookingId: text("booking_id").primaryKey(),
  contractId: text("contract_id").notNull(),
  outcome: text("outcome", { enum: DISPUTE_OUTCOMES }).notNull(),
  /** The unsigned resolve-dispute transaction's own hash -- the hash the
   * signed transaction lands with once submitted, so this row names exactly
   * the allocation Pactly signed. */
  txHash: text("tx_hash").notNull(),
  decidedAt: integer("decided_at").notNull(),
});
