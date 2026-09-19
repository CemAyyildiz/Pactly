#![no_std]

//! Pactly escrow contract.
//!
//! Story 1.2 defines the on-chain data model — [`Booking`], [`BookingState`],
//! [`Error`] and the storage keys — plus `initialize`, which records the
//! administrator. Story 1.3 adds `create_booking`, the one path that locks a
//! deposit in the contract's own custody. `release` and `resolve_cancel` arrive
//! in Stories 1.4 and 1.5 and extend the same `#[contractimpl]` block.

pub mod error;
pub mod events;
pub mod storage;
pub mod types;

pub use error::Error;
pub use types::{Booking, BookingId, BookingState};

use soroban_sdk::{contract, contractimpl, token::TokenClient, Address, Env};

use storage::LEDGER_CLOSE_SECONDS;

/// How long a booking must stay readable *after* its `cancel_deadline`.
///
/// The deadline is when a booking becomes settleable, not when it is settled:
/// Story 1.5's `resolve_cancel` transfers a no-show to the professional only
/// once the deadline has passed. A booking whose entry expires at the deadline
/// would therefore archive exactly as its settlement window opens, stranding
/// the deposit. 30 days is the grace period between the two.
const SETTLEMENT_MARGIN_SECONDS: u64 = 30 * 86_400;

/// How far into the future a `cancel_deadline` may sit, in seconds.
///
/// A booking's storage entry lives for [`storage::BUMP_LEDGERS`] ledgers past
/// its last write. The accepted deadline stops a full
/// [`SETTLEMENT_MARGIN_SECONDS`] short of that, so the record outlives not just
/// the deadline but the window in which the deadline can still be acted on.
const MAX_DEADLINE_AHEAD_SECONDS: u64 =
    storage::BUMP_LEDGERS as u64 * LEDGER_CLOSE_SECONDS - SETTLEMENT_MARGIN_SECONDS;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Record the contract administrator. Callable exactly once.
    ///
    /// Requires `admin`'s authorization, so nobody can claim the role on
    /// someone else's behalf. A second call leaves the stored admin untouched
    /// and returns [`Error::AlreadyInitialized`].
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();

        if storage::has_admin(&env) {
            return Err(Error::AlreadyInitialized);
        }

        storage::set_admin(&env, &admin);
        Ok(())
    }

    /// Read the contract administrator.
    ///
    /// Returns [`Error::NotInitialized`] before `initialize` has run.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        storage::get_admin(&env)
    }

    /// Lock a booking's deposit in the contract's custody.
    ///
    /// Requires `client`'s authorization: only the payer can move their own
    /// money, so the platform's own key can never call this. The deposit is
    /// pulled through the `token` contract into
    /// `env.current_contract_address()`, where it stays until Story 1.4's
    /// `release` or Story 1.5's `resolve_cancel` decides its outcome.
    ///
    /// `amount` is in the token's smallest unit; `cancel_deadline` is UTC epoch
    /// seconds, the same unit as the ledger timestamp.
    ///
    /// Authorization is checked first, then every validation, and only then is
    /// anything done: the transfer, the write and the event all come after the
    /// last check, so a rejected call has moved no tokens and left no trace.
    /// [`Error::NotInitialized`] before `initialize` has run,
    /// [`Error::InvalidAmount`] for a non-positive amount,
    /// [`Error::InvalidDeadline`] for a deadline already past or further out
    /// than a stored record's settleable lifetime, [`Error::InvalidParties`]
    /// when the professional is the client or this contract, and
    /// [`Error::BookingExists`] for an id already in use.
    pub fn create_booking(
        env: Env,
        booking_id: BookingId,
        professional: Address,
        client: Address,
        token: Address,
        amount: i128,
        cancel_deadline: u64,
    ) -> Result<(), Error> {
        client.require_auth();

        // Auth first, so an unsigned call never learns anything; this guard
        // next, so no deposit can be locked in a contract that has no admin.
        if !storage::has_admin(&env) {
            return Err(Error::NotInitialized);
        }

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // A deadline in the past is rejected rather than treated as an instant
        // no-show: it would create a booking `resolve_cancel` could settle to
        // the professional the moment it exists.
        let now = env.ledger().timestamp();
        if cancel_deadline <= now
            || cancel_deadline > now.saturating_add(MAX_DEADLINE_AHEAD_SECONDS)
        {
            return Err(Error::InvalidDeadline);
        }

        // A booking whose professional is its own client would round-trip the
        // deposit back to whoever paid it, and still count as a completed
        // session for that provider. The contract cannot be a party either: it
        // is the custodian, and paying itself would make the deposit
        // unreachable by either settlement path.
        let escrow = env.current_contract_address();
        if professional == client || professional == escrow {
            return Err(Error::InvalidParties);
        }

        if storage::has_booking(&env, &booking_id) {
            return Err(Error::BookingExists);
        }

        // The money moves before anything is written, so a failed transfer —
        // an underfunded client, say — leaves no record behind.
        TokenClient::new(&env, &token).transfer(&client, &escrow, &amount);

        storage::set_booking(
            &env,
            &booking_id,
            &Booking {
                professional,
                client,
                token,
                amount,
                cancel_deadline,
                state: BookingState::Locked,
            },
        );

        // Emitted last: the event is how the rest of the system learns money
        // moved, so it must not exist unless it did.
        events::Locked { booking_id, amount }.publish(&env);

        Ok(())
    }
}

#[cfg(test)]
mod test;
