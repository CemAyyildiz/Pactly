//! Foreseeable failures of the escrow contract.
//!
//! Discriminants are explicit and stable: clients off chain map these numbers to
//! messages, so Stories 1.3 to 1.5 append new variants with new numbers and
//! never renumber an existing one.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that already has an admin.
    AlreadyInitialized = 1,
    /// A contract function was called before `initialize`.
    NotInitialized = 2,
    /// A booking already exists under the supplied id.
    BookingExists = 3,
    /// No booking exists under the supplied id.
    BookingNotFound = 4,
    /// The deposit amount is not a positive number in the token's smallest unit.
    InvalidAmount = 5,
    /// The booking is not in a state that allows the requested transition.
    InvalidState = 6,
    /// The cancellation deadline is not inside the window the contract accepts:
    /// it is already in the past, or further out than a stored booking's TTL.
    InvalidDeadline = 7,
}
