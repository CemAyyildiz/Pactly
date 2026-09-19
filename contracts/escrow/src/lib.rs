#![no_std]

//! Pactly escrow contract.
//!
//! Story 1.2 defines the on-chain data model — [`Booking`], [`BookingState`],
//! [`Error`] and the storage keys — plus `initialize`, which records the
//! administrator. No money moves here: `create_booking`, `release` and
//! `resolve_cancel` arrive in Stories 1.3 to 1.5 and extend the same
//! `#[contractimpl]` block.

pub mod error;
pub mod storage;
pub mod types;

pub use error::Error;
pub use types::{Booking, BookingId, BookingState};

use soroban_sdk::{contract, contractimpl, Address, Env};

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
}

#[cfg(test)]
mod test;
