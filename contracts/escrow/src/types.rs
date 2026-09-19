//! On-chain data model for the escrow contract.
//!
//! Story 1.2 defines these shapes once; Stories 1.3 to 1.5 import them and must
//! not redefine any field, unit or variant.

use soroban_sdk::{contracttype, Address, BytesN};

/// Where a booking's deposit stands.
///
/// `Locked` is the only state a booking is created in. `Released` and
/// `Refunded` are terminal: once a booking reaches either one, no further
/// transition is legal.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BookingState {
    /// The deposit is held by the contract.
    Locked = 0,
    /// The deposit was transferred to the professional.
    Released = 1,
    /// The deposit was returned to the client.
    Refunded = 2,
}

/// A single escrowed booking.
///
/// Field order and units are fixed by the epic context:
/// - `amount` is in the asset's smallest unit (7 decimals for USDC); nothing in
///   this layer formats or converts currency.
/// - `cancel_deadline` is UTC epoch seconds, the same unit as the ledger
///   timestamp it is compared against.
/// - The booking id is supplied by the caller as `BytesN<16>` (an off-chain
///   ULID) and is the storage key, so it is not repeated inside the record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Booking {
    /// Receives the deposit when the booking is released or the client is a no-show.
    pub professional: Address,
    /// Paid the deposit; receives it back on an on-time cancellation.
    pub client: Address,
    /// Address of the token contract the deposit is denominated in.
    pub token: Address,
    /// Deposit amount in the token's smallest unit.
    pub amount: i128,
    /// UTC epoch seconds; before it the client may cancel for a refund.
    pub cancel_deadline: u64,
    /// Current state of the deposit.
    pub state: BookingState,
}

/// The id a booking is stored under: a 16-byte off-chain ULID.
pub type BookingId = BytesN<16>;
