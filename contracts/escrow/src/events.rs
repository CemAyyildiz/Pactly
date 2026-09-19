//! The single place the escrow contract's event shapes are defined.
//!
//! Events are the only way the rest of the system learns that money moved, so
//! their names and payloads are a public contract: Epic 2's event worker reads
//! them, and every story adds its event here rather than publishing ad hoc
//! topics at a call site. Story 1.5's `refunded`, `cancelled` and `forfeited`
//! join `locked` and `released` below.
//!
//! The name is the reason; the state is the destination. `released` and
//! `forfeited` both end with the professional holding the deposit and the
//! record reading [`crate::types::BookingState::Released`], and `refunded` and
//! `cancelled` both end with the client made whole and the record reading
//! `Refunded` — but Story 4.3's verified-session counter increments on
//! `released` alone and a provider's cancellation count on `cancelled` alone,
//! so a consumer that collapsed them would count a no-show as a held session.
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

/// A deposit has left the contract for the professional, the session held.
///
/// Emitted by `release` and by nothing else, only after the transfer out of the
/// contract address succeeded, so the event's existence means the money really
/// moved. Its wire shape is [`Locked`]'s, so the event worker handles both
/// symmetrically.
///
/// A deposit that reaches the professional because the client cancelled late or
/// never appeared emits [`Forfeited`] instead: only `released` means the client
/// confirmed the session, and Story 4.3's verified-session counter is derived
/// from that difference.
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

/// A deposit has gone back to the client, who cancelled inside their window.
///
/// Emitted by `cancel_by_client` when the call landed on or before the booking's
/// `cancel_deadline`, and only after the transfer out of the contract address
/// succeeded. The record becomes [`crate::types::BookingState::Refunded`].
///
/// [`Cancelled`] is its sibling for the same destination with a different
/// reason: there the professional called the session off, and only that counts
/// against the professional.
///
/// Topics: `("refunded", booking_id)`. Data: `amount`.
#[contractevent(topics = ["refunded"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refunded {
    /// The booking whose deposit was returned.
    #[topic]
    pub booking_id: BookingId,
    /// Amount returned to the client, in the token's smallest unit.
    pub amount: i128,
}

/// A deposit has gone back to the client because the professional cancelled.
///
/// Emitted by `cancel_by_professional`, whatever the ledger clock says, and only
/// after the transfer out of the contract address succeeded. The record becomes
/// [`crate::types::BookingState::Refunded`], exactly as for [`Refunded`] — the
/// destination is the same and the reason is not. A provider's cancellation
/// count is derived from this name alone, so it must never be emitted for a
/// cancellation the client initiated.
///
/// Topics: `("cancelled", booking_id)`. Data: `amount`.
#[contractevent(topics = ["cancelled"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cancelled {
    /// The booking the professional cancelled.
    #[topic]
    pub booking_id: BookingId,
    /// Amount returned to the client, in the token's smallest unit.
    pub amount: i128,
}

/// A deposit has gone to the professional for a session that did not happen.
///
/// Emitted by `cancel_by_client` past the deadline and by `claim_no_show`, and
/// only after the transfer out of the contract address succeeded. One name for
/// one outcome: whether the client admits the late cancellation or the
/// professional claims the silence, the deposit is forfeit the same way, so the
/// event worker never has to reconcile two names for the same fact.
///
/// The record becomes [`crate::types::BookingState::Released`], because that is
/// where the money went — but the event is deliberately *not* [`Released`], or a
/// no-show would count as a session the professional held.
///
/// Topics: `("forfeited", booking_id)`. Data: `amount`.
#[contractevent(topics = ["forfeited"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Forfeited {
    /// The booking whose deposit was forfeited.
    #[topic]
    pub booking_id: BookingId,
    /// Amount forfeited to the professional, in the token's smallest unit.
    pub amount: i128,
}
