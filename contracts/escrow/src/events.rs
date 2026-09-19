//! The single place the escrow contract's event shapes are defined.
//!
//! Events are the only way the rest of the system learns that money moved, so
//! their names and payloads are a public contract: Epic 2's event worker reads
//! them, and every story adds its event here rather than publishing ad hoc
//! topics at a call site. Story 1.5's refund event joins `locked` and
//! `released` below.
//!
//! Wire shape, fixed for all of them: topics are `(name, booking_id)` and the
//! data is the amount alone. The booking id sits in the topics so a consumer
//! can index or subscribe by booking; professional, client and token stay off
//! the payload because the backend already holds them in its own hold record.
//!
//! The events are declared with `#[contractevent]` rather than a raw
//! `env.events().publish(..)` call, which soroban-sdk 27 deprecates. The bytes
//! on the wire are the same — `test.rs` asserts the exact topic tuple and data
//! against the shape this module promises.

use soroban_sdk::contractevent;

use crate::types::BookingId;

/// A deposit is now held by the contract.
///
/// Emitted by `create_booking` only after the transfer into the contract
/// address succeeded, so the event's existence means the money really moved.
///
/// Topics: `("locked", booking_id)`. Data: `amount`.
#[contractevent(topics = ["locked"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Locked {
    /// The booking whose deposit was locked.
    #[topic]
    pub booking_id: BookingId,
    /// Deposit amount in the token's smallest unit.
    pub amount: i128,
}

/// A deposit has left the contract for the professional.
///
/// Emitted by `release` only after the transfer out of the contract address
/// succeeded, so the event's existence means the money really moved. Its wire
/// shape is [`Locked`]'s, so the event worker handles both symmetrically.
///
/// Topics: `("released", booking_id)`. Data: `amount`.
#[contractevent(topics = ["released"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    /// The booking whose deposit was paid out.
    #[topic]
    pub booking_id: BookingId,
    /// Amount paid to the professional, in the token's smallest unit.
    pub amount: i128,
}
