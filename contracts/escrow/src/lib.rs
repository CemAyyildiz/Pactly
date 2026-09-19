#![no_std]

//! Pactly escrow contract.
//!
//! Story 1.2 defines the on-chain data model — [`Booking`], [`BookingState`],
//! [`Error`] and the storage keys — plus `initialize`, which records the
//! administrator. Story 1.3 adds `create_booking`, the one path that locks a
//! deposit in the contract's own custody, and Story 1.4 adds `release`, the one
//! path it leaves for the professional when the client confirms the session.
//! Story 1.5 extends the same `#[contractimpl]` block with the three ways a
//! booking ends without that confirmation — `cancel_by_professional`,
//! `cancel_by_client` and `claim_no_show` — each signed by the party it serves.

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
/// The deadline ends the free-cancellation window, it does not settle the
/// booking: `claim_no_show` may only transfer a deposit to the professional
/// once the deadline has passed, and a late `cancel_by_client` likewise. A
/// booking whose entry expired at the deadline would therefore archive exactly
/// as that window opens, stranding the deposit. 30 days is the grace period
/// between the two.
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
    /// `release` or one of Story 1.5's three cancellation paths decides its
    /// outcome.
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
        // no-show: it would create a booking whose free-cancellation window was
        // already shut, so `claim_no_show` could hand the deposit to the
        // professional the moment it exists.
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

    /// Pay a locked deposit out to the booking's professional.
    ///
    /// Requires the authorization of the **client recorded on the booking**, not
    /// of whoever submitted the transaction: the payer is the only party who can
    /// declare the work done, so the platform's own key can never release a
    /// deposit. The record has to be read before the contract knows whose
    /// signature to demand, so the lookup precedes the auth check and an unknown
    /// id is answerable without a signature — booking ids are generated off
    /// chain and carry no secret.
    ///
    /// The full stored `amount` moves from `env.current_contract_address()` to
    /// the professional through the booking's own token; no fee, no cut, no
    /// partial release. The record then becomes [`BookingState::Released`],
    /// which is terminal.
    ///
    /// [`Error::BookingNotFound`] for an unknown id, and [`Error::InvalidState`]
    /// for a booking that has already been released or refunded — so a repeated
    /// call pays the professional exactly once.
    pub fn release(env: Env, booking_id: BookingId) -> Result<(), Error> {
        let mut booking = storage::get_booking(&env, &booking_id)?;

        booking.client.require_auth();

        // Checked after auth: only the client may learn whether their own
        // booking is still releasable.
        if booking.state != BookingState::Locked {
            return Err(Error::InvalidState);
        }

        // Same order as `create_booking`. Atomicity is the host's doing, not the
        // ordering's: a token that traps aborts the whole invocation and rolls
        // back every write, so no booking can read `Released` without the money
        // having moved whichever way round these two run. The order that is kept
        // is the house pattern — one shape for every money path in this
        // contract. Story 1.5's three cancellation paths keep that same shape
        // through their own shared `settle` helper.
        TokenClient::new(&env, &booking.token).transfer(
            &env.current_contract_address(),
            &booking.professional,
            &booking.amount,
        );

        booking.state = BookingState::Released;
        let amount = booking.amount;
        storage::set_booking(&env, &booking_id, &booking);

        // Emitted last, for the same reason as `locked`: the event must not
        // exist unless the money really moved.
        events::Released { booking_id, amount }.publish(&env);

        Ok(())
    }

    /// Call a booking off on the professional's side, refunding the client.
    ///
    /// Requires the authorization of the **professional recorded on the
    /// booking**. The full stored `amount` goes back to the client and the
    /// record becomes [`BookingState::Refunded`], **whatever the ledger clock
    /// says**: the free-cancellation window bounds what the *client* may do, and
    /// a professional is never paid for a session they themselves cancelled, no
    /// matter how late they call it off.
    ///
    /// Emits `cancelled` rather than `refunded`, because a provider's
    /// cancellation count is derived from that name alone.
    ///
    /// [`Error::BookingNotFound`] for an unknown id, and [`Error::InvalidState`]
    /// for a booking already released or refunded.
    pub fn cancel_by_professional(env: Env, booking_id: BookingId) -> Result<(), Error> {
        let mut booking = storage::get_booking(&env, &booking_id)?;

        booking.professional.require_auth();

        // Checked after auth, as in `release`: only a party to the booking may
        // learn whether it is still settleable.
        if booking.state != BookingState::Locked {
            return Err(Error::InvalidState);
        }

        // No clock comparison anywhere in this path, deliberately: a deadline
        // that has passed is the end of the client's free-cancellation window
        // and says nothing about the professional's obligations.
        let amount = settle(&env, &booking_id, &mut booking, Payee::Client);

        events::Cancelled { booking_id, amount }.publish(&env);

        Ok(())
    }

    /// Call a booking off on the client's side, refunding or forfeiting.
    ///
    /// Requires the authorization of the **client recorded on the booking**. The
    /// ledger clock decides only where the deposit goes:
    /// - `now <= cancel_deadline` — inside the free-cancellation window. The
    ///   full amount returns to the client, the record becomes
    ///   [`BookingState::Refunded`] and a `refunded` event is emitted. The
    ///   boundary second belongs to the client: the deadline is published to
    ///   them as the end of that window, so the window includes it.
    /// - `now > cancel_deadline` — a late cancellation. The full amount goes to
    ///   the professional, the record becomes [`BookingState::Released`] and a
    ///   `forfeited` event is emitted — never `released`, which would count the
    ///   booking as a session the professional held.
    ///
    /// No partial refund, no fee, no split: whichever side the clock picks
    /// receives the whole stored amount.
    ///
    /// [`Error::BookingNotFound`] for an unknown id, and [`Error::InvalidState`]
    /// for a booking already released or refunded.
    pub fn cancel_by_client(env: Env, booking_id: BookingId) -> Result<(), Error> {
        let mut booking = storage::get_booking(&env, &booking_id)?;

        booking.client.require_auth();

        if booking.state != BookingState::Locked {
            return Err(Error::InvalidState);
        }

        // `<=`, not `<`: the client keeps the second the deadline names.
        if env.ledger().timestamp() <= booking.cancel_deadline {
            let amount = settle(&env, &booking_id, &mut booking, Payee::Client);
            events::Refunded { booking_id, amount }.publish(&env);
        } else {
            let amount = settle(&env, &booking_id, &mut booking, Payee::Professional);
            events::Forfeited { booking_id, amount }.publish(&env);
        }

        Ok(())
    }

    /// Claim the deposit of a booking whose client never came back.
    ///
    /// Requires the authorization of the **professional recorded on the
    /// booking**. This is the counterpart of [`Self::cancel_by_professional`]
    /// for a silent client: a client who simply never signs anything would
    /// otherwise strand the deposit in the contract forever.
    ///
    /// Legal only once the client's free-cancellation window has shut —
    /// [`Error::TooEarly`] while `now <= cancel_deadline`, since until then the
    /// client is still entitled to cancel for a full refund. After it, the full
    /// amount goes to the professional, the record becomes
    /// [`BookingState::Released`] and a `forfeited` event is emitted, the very
    /// same outcome a late [`Self::cancel_by_client`] produces: one event for
    /// one outcome, whoever initiates it.
    ///
    /// A passed deadline is not proof the session is over — it only means the
    /// free-cancellation window closed — so this path claims a forfeited
    /// deposit, never a delivered session. That is why it may not emit
    /// `released`.
    ///
    /// [`Error::BookingNotFound`] for an unknown id, and [`Error::InvalidState`]
    /// for a booking already released or refunded.
    pub fn claim_no_show(env: Env, booking_id: BookingId) -> Result<(), Error> {
        let mut booking = storage::get_booking(&env, &booking_id)?;

        booking.professional.require_auth();

        // State before the clock: a booking that is already terminal is refused
        // for that reason on every path, whenever the claim was made.
        if booking.state != BookingState::Locked {
            return Err(Error::InvalidState);
        }

        // Mirror of `cancel_by_client`'s comparison, so the two can never both
        // be legal on the same second: while the client may still cancel for
        // free, the professional may not claim.
        if env.ledger().timestamp() <= booking.cancel_deadline {
            return Err(Error::TooEarly);
        }

        let amount = settle(&env, &booking_id, &mut booking, Payee::Professional);

        events::Forfeited { booking_id, amount }.publish(&env);

        Ok(())
    }
}

/// Which side of a booking a settlement pays out to.
///
/// Not stored and not on the wire: it exists so the destination and the state
/// recorded for it are chosen together, once, instead of at each call site.
enum Payee {
    /// The client gets their deposit back; the record reads `Refunded`.
    Client,
    /// The professional is paid; the record reads `Released`.
    Professional,
}

/// Move a locked booking's whole deposit out and record where it went.
///
/// The shared tail of every settlement path: transfer, then write, then the
/// caller emits. Returns the amount moved, because the caller needs it for the
/// event after `booking` has been handed over to storage.
///
/// [`BookingState::Released`] and [`BookingState::Refunded`] partition the two
/// destinations, so the state is derived from the payee here rather than passed
/// alongside it — no path can pay one party and record the other.
///
/// The event stays with the caller: the destination is shared between paths, the
/// reason never is.
fn settle(env: &Env, booking_id: &BookingId, booking: &mut Booking, payee: Payee) -> i128 {
    let (recipient, state) = match payee {
        Payee::Client => (booking.client.clone(), BookingState::Refunded),
        Payee::Professional => (booking.professional.clone(), BookingState::Released),
    };

    // Transfer before the write, the house pattern `create_booking` and
    // `release` set. Atomicity is the host's doing rather than the ordering's —
    // a token that traps rolls back every write in the invocation.
    TokenClient::new(env, &booking.token).transfer(
        &env.current_contract_address(),
        &recipient,
        &booking.amount,
    );

    booking.state = state;
    storage::set_booking(env, booking_id, booking);

    booking.amount
}

#[cfg(test)]
mod test;
