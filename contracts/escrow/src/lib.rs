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

/// The network's target ledger close time, in seconds.
///
/// Used only to turn [`storage::BUMP_LEDGERS`] into a span of wall-clock time;
/// the contract never assumes ledgers close on schedule for anything else.
const LEDGER_CLOSE_SECONDS: u64 = 5;

/// How far into the future a `cancel_deadline` may sit, in seconds.
///
/// A booking's storage entry lives for [`storage::BUMP_LEDGERS`] ledgers past
/// its last write. A deadline beyond that could outlive the record itself,
/// which would strand a locked deposit, so such a booking is never created.
const MAX_DEADLINE_AHEAD_SECONDS: u64 = storage::BUMP_LEDGERS as u64 * LEDGER_CLOSE_SECONDS;

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
    /// Validation runs cheapest-first and the transfer is last, so a rejected
    /// call has never moved tokens: [`Error::InvalidAmount`] for a non-positive
    /// amount, [`Error::InvalidDeadline`] for a deadline already past or
    /// further out than a stored record's lifetime, [`Error::BookingExists`]
    /// for an id already in use.
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

        if storage::has_booking(&env, &booking_id) {
            return Err(Error::BookingExists);
        }

        // The money moves before anything is written, so a failed transfer —
        // an underfunded client, say — leaves no record behind.
        TokenClient::new(&env, &token).transfer(
            &client,
            &env.current_contract_address(),
            &amount,
        );

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
