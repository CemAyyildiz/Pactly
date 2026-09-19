//! The single place the escrow contract touches storage.
//!
//! Every read and write goes through a helper here, so the storage keys, the
//! persistent/instance choice and the TTL policy are decided once instead of at
//! each call site in Stories 1.3 to 1.5.
//!
//! TTL policy: only the write helpers bump. Reads stay read-only so a view call
//! never has to write to the ledger. A booking's entry must outlive its
//! `cancel_deadline` — an archived entry would strand a locked deposit — so
//! `create_booking` (Story 1.3) must reject a `cancel_deadline` further out than
//! [`BUMP_LEDGERS`] worth of time from now.

use soroban_sdk::{contracttype, Address, Env};

use crate::error::Error;
use crate::types::{Booking, BookingId};

/// The network's target ledger close time, in seconds.
///
/// The single source of the seconds-per-ledger assumption: [`DAY_IN_LEDGERS`]
/// is derived from it below, and `lib.rs` imports it to turn [`BUMP_LEDGERS`]
/// back into a span of wall-clock time. Two copies of this number could drift
/// apart and silently widen the deadline window past the TTL it is bounded by.
pub const LEDGER_CLOSE_SECONDS: u64 = 5;

/// Ledgers closed in roughly one day at the target close time.
const DAY_IN_LEDGERS: u32 = (86_400 / LEDGER_CLOSE_SECONDS) as u32;

/// How far ahead a persistent entry's TTL is pushed when it is written.
///
/// 120 days: long enough that a booking outlives a far-out `cancel_deadline`,
/// and still under the 3_110_400-ledger network maximum.
pub const BUMP_LEDGERS: u32 = 120 * DAY_IN_LEDGERS;

/// Bump only once an entry has less than this much life left, so a hot entry is
/// not re-extended on every single call.
pub const BUMP_THRESHOLD_LEDGERS: u32 = BUMP_LEDGERS - DAY_IN_LEDGERS;

/// Keys of every entry the contract stores.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// The contract administrator, written once by `initialize`.
    Admin,
    /// One booking record, keyed by its caller-supplied 16-byte id.
    Booking(BookingId),
}

/// Whether `initialize` has already run.
pub fn has_admin(env: &Env) -> bool {
    env.storage().persistent().has(&DataKey::Admin)
}

/// Store the administrator. Callers check [`has_admin`] first.
pub fn set_admin(env: &Env, admin: &Address) {
    let key = DataKey::Admin;
    env.storage().persistent().set(&key, admin);
    bump(env, &key);
}

/// Read the administrator. Does not write, so a view call stays read-only.
///
/// Returns [`Error::NotInitialized`] when `initialize` has not run yet.
pub fn get_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

/// Whether a booking is already stored under `booking_id`.
pub fn has_booking(env: &Env, booking_id: &BookingId) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Booking(booking_id.clone()))
}

/// Write a booking record, creating or replacing it.
pub fn set_booking(env: &Env, booking_id: &BookingId, booking: &Booking) {
    let key = DataKey::Booking(booking_id.clone());
    env.storage().persistent().set(&key, booking);
    bump(env, &key);
}

/// Read a booking record. Does not write, so a view call stays read-only.
///
/// Returns [`Error::BookingNotFound`] when nothing is stored under `booking_id`.
pub fn get_booking(env: &Env, booking_id: &BookingId) -> Result<Booking, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Booking(booking_id.clone()))
        .ok_or(Error::BookingNotFound)
}

/// Push a persistent entry's TTL out so an active booking is not archived.
fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD_LEDGERS, BUMP_LEDGERS);
}
