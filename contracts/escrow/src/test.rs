#![cfg(test)]

use soroban_sdk::{
    symbol_short,
    testutils::{
        storage::Persistent as _, Address as _, BytesN as _, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, ConversionError, Env, IntoVal, InvokeError, Val, Vec,
};

use crate::storage::{self, DataKey, BUMP_LEDGERS};
use crate::types::{Booking, BookingId, BookingState};
use crate::storage::LEDGER_CLOSE_SECONDS;
use crate::{
    EscrowContract, EscrowContractClient, Error, MAX_DEADLINE_AHEAD_SECONDS,
    SETTLEMENT_MARGIN_SECONDS,
};

fn setup() -> (Env, Address, EscrowContractClient<'static>) {
    let env = Env::default();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    (env, contract_id, client)
}

/// A ledger timestamp far enough from zero that "before now" is expressible.
const NOW: u64 = 1_767_225_600;

/// What `try_create_booking` returns: `Ok(Ok(()))` on success, `Err(Ok(error))`
/// for a contract error, `Err(Err(..))` for a host error such as a failed
/// `require_auth` or a token contract that trapped.
type CreateResult = Result<Result<(), ConversionError>, Result<Error, InvokeError>>;

/// What `create_booking` is called with, so a test only states what it changes.
struct Fixture {
    env: Env,
    contract_id: Address,
    client_contract: EscrowContractClient<'static>,
    token: Address,
    booking_id: BookingId,
    professional: Address,
    client: Address,
    amount: i128,
    cancel_deadline: u64,
}

impl Fixture {
    /// A registered escrow, a Stellar asset contract, and a client funded with
    /// `funding` of it. Auth is mocked; a test that needs real auth overrides it.
    fn new(funding: i128) -> Self {
        let (env, contract_id, client_contract) = setup();
        env.mock_all_auths();
        env.ledger().set_timestamp(NOW);

        // `create_booking` refuses to lock a deposit in a contract with no
        // admin, so every fixture starts initialized.
        client_contract.initialize(&Address::generate(&env));

        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(token_admin).address();
        let client = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&client, &funding);

        // A fixed id, not `BytesN::random`: the test env writes a ledger
        // snapshot per test, and a random id would rewrite it on every run.
        let booking_id = BytesN::from_array(&env, &[0x1d; 16]);
        let professional = Address::generate(&env);

        Self {
            env,
            contract_id,
            client_contract,
            token,
            booking_id,
            professional,
            client,
            amount: 250_000_000,
            cancel_deadline: NOW + 86_400,
        }
    }

    fn create(&self) -> CreateResult {
        self.client_contract.try_create_booking(
            &self.booking_id,
            &self.professional,
            &self.client,
            &self.token,
            &self.amount,
            &self.cancel_deadline,
        )
    }

    fn token_client(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }

    /// Only the escrow's own events; the token contract emits its own transfer.
    fn own_events(&self) -> soroban_sdk::testutils::ContractEvents {
        self.env.events().all().filter_by_contract(&self.contract_id)
    }

    fn expected_locked_event(&self) -> Vec<(Address, Vec<Val>, Val)> {
        let topics: Vec<Val> =
            (symbol_short!("locked"), self.booking_id.clone()).into_val(&self.env);
        vec![
            &self.env,
            (
                self.contract_id.clone(),
                topics,
                self.amount.into_val(&self.env),
            ),
        ]
    }
}

#[test]
fn contract_registers_in_test_env() {
    let env = Env::default();
    let contract_id = env.register(EscrowContract, ());

    // A registered contract gets a distinct address.
    let other_id = env.register(EscrowContract, ());
    assert_ne!(contract_id, other_id);
}

// Matrix row: first initialize.
#[test]
fn initialize_stores_the_admin() {
    let (env, _contract_id, client) = setup();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    assert_eq!(client.try_initialize(&admin), Ok(Ok(())));
    assert_eq!(client.get_admin(), admin);
}

// Matrix row: second initialize.
#[test]
fn second_initialize_is_rejected_and_keeps_the_first_admin() {
    let (env, _contract_id, client) = setup();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let other = Address::generate(&env);

    client.initialize(&admin);

    assert_eq!(
        client.try_initialize(&other),
        Err(Ok(Error::AlreadyInitialized))
    );
    assert_eq!(client.get_admin(), admin);
}

// Matrix row: initialize without authorization.
#[test]
#[should_panic(expected = "Unauthorized")]
fn initialize_without_authorization_fails() {
    // No `mock_all_auths`, so the admin's `require_auth` finds no signature.
    let (env, _contract_id, client) = setup();
    let admin = Address::generate(&env);

    client.initialize(&admin);
}

// Matrix row: initialize without authorization — nothing is stored.
#[test]
fn initialize_without_authorization_stores_nothing() {
    let (env, contract_id, client) = setup();
    let admin = Address::generate(&env);

    // A host auth error (`Err(Err(..))`), not a contract error (`Err(Ok(..))`).
    assert_eq!(
        client.try_initialize(&admin),
        Err(Err(InvokeError::Abort)),
        "expected the host auth error, not a contract error"
    );
    env.as_contract(&contract_id, || {
        assert!(!storage::has_admin(&env));
    });
}

// `require_auth` runs before the already-initialized check, so an unauthorized
// second call fails on auth and never reveals that an admin exists.
#[test]
fn second_initialize_checks_authorization_before_the_admin_check() {
    let (env, _contract_id, client) = setup();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    client.initialize(&admin);

    // Switch to enforcing auth with no signatures supplied.
    env.set_auths(&[]);

    assert_eq!(
        client.try_initialize(&admin),
        Err(Err(InvokeError::Abort)),
        "expected the host auth error, not Error::AlreadyInitialized"
    );
}

// Only the admin's own signature, for this exact call, authorizes `initialize`.
#[test]
fn initialize_requires_the_admins_own_authorization() {
    let (env, contract_id, client) = setup();
    let admin = Address::generate(&env);
    let stranger = Address::generate(&env);

    // A stranger's signature for the same call does not authorize it.
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(client.try_initialize(&admin), Err(Err(InvokeError::Abort)));

    // The admin's own signature for that same call does.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(client.try_initialize(&admin), Ok(Ok(())));
    assert_eq!(client.get_admin(), admin);
}

// Matrix row: admin read after initialize.
#[test]
fn get_admin_returns_the_stored_admin() {
    let (env, _contract_id, client) = setup();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    client.initialize(&admin);

    assert_eq!(client.try_get_admin(), Ok(Ok(admin)));
}

// Matrix row: admin read before initialize.
#[test]
fn get_admin_before_initialize_reports_not_initialized() {
    let (_env, _contract_id, client) = setup();

    assert_eq!(client.try_get_admin(), Err(Ok(Error::NotInitialized)));
}

// Matrix row: booking round-trip through the storage helper.
#[test]
fn booking_round_trips_through_the_storage_helper() {
    let (env, contract_id, _client) = setup();
    let booking_id = BytesN::<16>::random(&env);
    let booking = Booking {
        professional: Address::generate(&env),
        client: Address::generate(&env),
        token: Address::generate(&env),
        amount: 250_000_000_i128,
        cancel_deadline: 1_767_225_600_u64,
        state: BookingState::Locked,
    };

    env.as_contract(&contract_id, || {
        assert!(!storage::has_booking(&env, &booking_id));

        storage::set_booking(&env, &booking_id, &booking);

        assert!(storage::has_booking(&env, &booking_id));
        let stored = storage::get_booking(&env, &booking_id).unwrap();
        assert_eq!(stored.professional, booking.professional);
        assert_eq!(stored.client, booking.client);
        assert_eq!(stored.token, booking.token);
        assert_eq!(stored.amount, 250_000_000_i128);
        assert_eq!(stored.cancel_deadline, 1_767_225_600_u64);
        assert_eq!(stored.state, BookingState::Locked);
        assert_eq!(stored, booking);
    });
}

// Matrix row: booking read for an unknown id.
#[test]
fn unknown_booking_id_reports_booking_not_found() {
    let (env, contract_id, _client) = setup();
    let unknown_id = BytesN::<16>::random(&env);

    env.as_contract(&contract_id, || {
        assert!(!storage::has_booking(&env, &unknown_id));
        assert_eq!(
            storage::get_booking(&env, &unknown_id),
            Err(Error::BookingNotFound)
        );
    });
}

// Writes push a persistent entry's TTL out to the full bump window, so an
// active booking outlives its cancel deadline.
#[test]
fn writes_extend_the_persistent_ttl_to_the_bump_window() {
    let (env, contract_id, _client) = setup();
    let admin = Address::generate(&env);
    let booking_id = BytesN::<16>::random(&env);
    let booking = Booking {
        professional: Address::generate(&env),
        client: Address::generate(&env),
        token: Address::generate(&env),
        amount: 1_i128,
        cancel_deadline: 1_767_225_600_u64,
        state: BookingState::Locked,
    };

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &admin);
        storage::set_booking(&env, &booking_id, &booking);

        let storage = env.storage().persistent();
        assert_eq!(storage.get_ttl(&DataKey::Admin), BUMP_LEDGERS);
        assert_eq!(
            storage.get_ttl(&DataKey::Booking(booking_id.clone())),
            BUMP_LEDGERS
        );
    });
}

// Booking states are written on chain as integers and read off chain by number:
// the discriminants must not shift.
#[test]
fn booking_state_discriminants_are_stable() {
    assert_eq!(BookingState::Locked as u32, 0);
    assert_eq!(BookingState::Released as u32, 1);
    assert_eq!(BookingState::Refunded as u32, 2);
}

// Error discriminants are part of the off-chain contract: they must not shift.
#[test]
fn error_discriminants_are_stable() {
    assert_eq!(Error::AlreadyInitialized as u32, 1);
    assert_eq!(Error::NotInitialized as u32, 2);
    assert_eq!(Error::BookingExists as u32, 3);
    assert_eq!(Error::BookingNotFound as u32, 4);
    assert_eq!(Error::InvalidAmount as u32, 5);
    assert_eq!(Error::InvalidState as u32, 6);
    assert_eq!(Error::InvalidDeadline as u32, 7);
    assert_eq!(Error::InvalidParties as u32, 8);
}

// The deadline window is a product of three constants in two modules
// (`BUMP_LEDGERS`, `LEDGER_CLOSE_SECONDS`, `SETTLEMENT_MARGIN_SECONDS`).
// Pinning the result as wall-clock literals means a change to any one of them
// has to be a deliberate change to the window, not a silent side effect.
#[test]
fn the_deadline_window_constants_are_stable() {
    const DAY: u64 = 86_400;

    assert_eq!(LEDGER_CLOSE_SECONDS, 5, "seconds per ledger");
    assert_eq!(BUMP_LEDGERS as u64 * LEDGER_CLOSE_SECONDS, 120 * DAY, "TTL");
    assert_eq!(SETTLEMENT_MARGIN_SECONDS, 30 * DAY, "settlement margin");

    // A deadline may sit up to 90 days out: the 120-day storage lifetime less
    // the 30 days a booking must stay settleable after its deadline.
    assert_eq!(MAX_DEADLINE_AHEAD_SECONDS, 90 * DAY);
}

// ---------------------------------------------------------------------------
// Story 1.3 — create_booking
// ---------------------------------------------------------------------------

// Matrix row: deposit locked.
#[test]
fn deposit_is_locked_and_the_balances_move() {
    let f = Fixture::new(1_000_000_000);

    assert_eq!(f.create(), Ok(Ok(())));

    // The `locked` event carries the booking id in its topics and the amount as
    // data. Checked first: `events().all()` only covers the last invocation, and
    // reading a balance is one.
    assert_eq!(f.own_events(), f.expected_locked_event());

    // The contract holds exactly the deposit; the client's balance dropped by it.
    let token = f.token_client();
    assert_eq!(token.balance(&f.contract_id), f.amount);
    assert_eq!(token.balance(&f.client), 1_000_000_000 - f.amount);

    // The record is written in Locked state, with the fields as supplied.
    f.env.as_contract(&f.contract_id, || {
        let stored = storage::get_booking(&f.env, &f.booking_id).unwrap();
        assert_eq!(
            stored,
            Booking {
                professional: f.professional.clone(),
                client: f.client.clone(),
                token: f.token.clone(),
                amount: f.amount,
                cancel_deadline: f.cancel_deadline,
                state: BookingState::Locked,
            }
        );
    });
}

// The write must bump the entry's TTL, or a booking could be archived before
// its deadline and strand the deposit.
#[test]
fn locking_a_deposit_bumps_the_bookings_ttl() {
    let f = Fixture::new(1_000_000_000);

    f.create().unwrap().unwrap();

    f.env.as_contract(&f.contract_id, || {
        assert_eq!(
            f.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Booking(f.booking_id.clone())),
            BUMP_LEDGERS
        );
    });
}

// Matrix row: duplicate id.
#[test]
fn duplicate_booking_id_is_rejected_and_changes_nothing() {
    let f = Fixture::new(1_000_000_000);
    f.create().unwrap().unwrap();

    let balance_after_first = f.token_client().balance(&f.contract_id);

    // Same id, different amount: if the second call got through, the stored
    // record and the balances would show it.
    let second = f.client_contract.try_create_booking(
        &f.booking_id,
        &f.professional,
        &f.client,
        &f.token,
        &(f.amount * 2),
        &f.cancel_deadline,
    );

    assert_eq!(second, Err(Ok(Error::BookingExists)));
    assert!(
        f.own_events().events().is_empty(),
        "a rejected call must emit no event"
    );
    let token = f.token_client();
    assert_eq!(token.balance(&f.contract_id), balance_after_first);
    assert_eq!(
        token.balance(&f.client),
        1_000_000_000 - f.amount,
        "the rejected second call charged the client again"
    );
    f.env.as_contract(&f.contract_id, || {
        let stored = storage::get_booking(&f.env, &f.booking_id).unwrap();
        assert_eq!(stored.amount, f.amount, "the stored record was overwritten");
    });
}

// Bookings are independent records keyed by id: a second one under a distinct
// id coexists with the first, and the contract custodies the sum.
#[test]
fn a_second_booking_under_a_distinct_id_coexists_with_the_first() {
    let f = Fixture::new(1_000_000_000);
    f.create().unwrap().unwrap();

    let second_id = BytesN::from_array(&f.env, &[0x2e; 16]);
    let second_amount = 75_000_000_i128;
    let second_deadline = f.cancel_deadline + 3_600;
    let second_professional = Address::generate(&f.env);

    assert_eq!(
        f.client_contract.try_create_booking(
            &second_id,
            &second_professional,
            &f.client,
            &f.token,
            &second_amount,
            &second_deadline,
        ),
        Ok(Ok(()))
    );

    let token = f.token_client();
    assert_eq!(token.balance(&f.contract_id), f.amount + second_amount);
    assert_eq!(
        token.balance(&f.client),
        1_000_000_000 - f.amount - second_amount
    );

    // Both records are intact and distinct.
    f.env.as_contract(&f.contract_id, || {
        let first = storage::get_booking(&f.env, &f.booking_id).unwrap();
        let second = storage::get_booking(&f.env, &second_id).unwrap();
        assert_eq!(first.amount, f.amount);
        assert_eq!(first.professional, f.professional);
        assert_eq!(second.amount, second_amount);
        assert_eq!(second.professional, second_professional);
        assert_eq!(second.cancel_deadline, second_deadline);
        assert_eq!(second.state, BookingState::Locked);
    });
}

// Matrix row: zero or negative amount.
#[test]
fn non_positive_amount_is_rejected_and_stores_nothing() {
    for amount in [0_i128, -1_i128, -250_000_000_i128] {
        let mut f = Fixture::new(1_000_000_000);
        f.amount = amount;

        assert_eq!(f.create(), Err(Ok(Error::InvalidAmount)), "amount {amount}");

        assert_no_effect(&f, 1_000_000_000);
    }
}

// Matrix row: deadline already passed.
#[test]
fn deadline_in_the_past_is_rejected_and_stores_nothing() {
    // Exactly now counts as passed: a booking must have a window to cancel in.
    for cancel_deadline in [0_u64, NOW - 1, NOW] {
        let mut f = Fixture::new(1_000_000_000);
        f.cancel_deadline = cancel_deadline;

        assert_eq!(
            f.create(),
            Err(Ok(Error::InvalidDeadline)),
            "deadline {cancel_deadline}"
        );

        assert_no_effect(&f, 1_000_000_000);
    }
}

// Matrix row: deadline beyond the TTL window.
#[test]
fn deadline_beyond_the_ttl_window_is_rejected_and_stores_nothing() {
    let mut f = Fixture::new(1_000_000_000);
    f.cancel_deadline = NOW + MAX_DEADLINE_AHEAD_SECONDS + 1;

    assert_eq!(f.create(), Err(Ok(Error::InvalidDeadline)));

    assert_no_effect(&f, 1_000_000_000);
}

// The edge of that window is still accepted, so the boundary is exact rather
// than approximately right. The bound sits a settlement margin short of the
// storage lifetime, so a booking created here still has 30 days of readable
// life after its deadline — the window `resolve_cancel` acts in.
#[test]
fn deadline_at_the_edge_of_the_accepted_window_is_accepted() {
    let mut f = Fixture::new(1_000_000_000);
    f.cancel_deadline = NOW + MAX_DEADLINE_AHEAD_SECONDS;

    assert_eq!(f.create(), Ok(Ok(())));
    assert_eq!(f.token_client().balance(&f.contract_id), f.amount);

    // The record outlives its own deadline by the full margin.
    let entry_expires_at = NOW + BUMP_LEDGERS as u64 * LEDGER_CLOSE_SECONDS;
    assert_eq!(
        entry_expires_at - f.cancel_deadline,
        SETTLEMENT_MARGIN_SECONDS
    );
}

// The deadline bound is computed from the ledger timestamp, so a timestamp near
// the end of the u64 range must not wrap it into a value that rejects
// everything.
#[test]
fn a_ledger_timestamp_near_the_end_of_time_does_not_wrap_the_deadline_bound() {
    let f = Fixture::new(1_000_000_000);
    f.env.ledger().set_timestamp(u64::MAX - 1);

    // One second ahead of `now`: comfortably inside the window, and only
    // reachable if the upper bound saturates instead of wrapping.
    let result = f.client_contract.try_create_booking(
        &f.booking_id,
        &f.professional,
        &f.client,
        &f.token,
        &f.amount,
        &u64::MAX,
    );

    assert_eq!(result, Ok(Ok(())));
}

// A contract with no admin holds no deposits: `initialize` is the gate.
#[test]
fn create_booking_before_initialize_reports_not_initialized() {
    // A bare contract, deliberately not the initialized `Fixture`.
    let (env, contract_id, contract) = setup();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();
    let client = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&client, &1_000_000_000);

    let booking_id = BytesN::from_array(&env, &[0x1d; 16]);
    let result = contract.try_create_booking(
        &booking_id,
        &Address::generate(&env),
        &client,
        &token,
        &250_000_000_i128,
        &(NOW + 86_400),
    );

    assert_eq!(result, Err(Ok(Error::NotInitialized)));
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
    env.as_contract(&contract_id, || {
        assert!(!storage::has_booking(&env, &booking_id));
    });
}

// A booking whose professional is its own client pays the deposit straight back
// to the payer, and would still count as a session that provider delivered.
#[test]
fn a_client_cannot_be_their_own_professional() {
    let mut f = Fixture::new(1_000_000_000);
    f.professional = f.client.clone();

    assert_eq!(f.create(), Err(Ok(Error::InvalidParties)));

    assert_no_effect(&f, 1_000_000_000);
}

// The escrow is the custodian, never a counterparty: a deposit owed to the
// contract itself could not be reached by release or by resolve_cancel.
#[test]
fn the_escrow_contract_cannot_be_the_professional() {
    let mut f = Fixture::new(1_000_000_000);
    f.professional = f.contract_id.clone();

    assert_eq!(f.create(), Err(Ok(Error::InvalidParties)));

    assert_no_effect(&f, 1_000_000_000);
}

// Matrix row: client did not authorize.
#[test]
fn without_the_clients_authorization_nothing_is_stored_or_transferred() {
    let f = Fixture::new(1_000_000_000);
    // Switch from `mock_all_auths` to enforcing auth with no signatures supplied.
    f.env.set_auths(&[]);

    // A host auth error (`Err(Err(..))`), not a contract error (`Err(Ok(..))`).
    assert_eq!(
        f.create(),
        Err(Err(InvokeError::Abort)),
        "expected the host auth error, not a contract error"
    );

    assert_no_effect(&f, 1_000_000_000);
}

// `require_auth` must run before any validation or storage read. Otherwise an
// unsigned call that gets back `BookingExists` rather than an auth failure is a
// free oracle for whether a given booking id is in use.
#[test]
fn create_booking_checks_authorization_before_validation_and_storage() {
    let f = Fixture::new(1_000_000_000);
    f.create().unwrap().unwrap();

    // Switch to enforcing auth with no signatures supplied.
    f.env.set_auths(&[]);

    // An id that exists *and* an amount that fails validation: whichever check
    // ran first would return its own contract error and answer the question.
    let result = f.client_contract.try_create_booking(
        &f.booking_id,
        &f.professional,
        &f.client,
        &f.token,
        &0_i128,
        &f.cancel_deadline,
    );

    assert_eq!(
        result,
        Err(Err(InvokeError::Abort)),
        "expected the host auth error, not Error::BookingExists or Error::InvalidAmount"
    );
}

// Only the client's own signature authorizes the deposit: neither the
// professional's nor the platform's key may move the client's money.
#[test]
fn only_the_clients_own_authorization_creates_a_booking() {
    let f = Fixture::new(1_000_000_000);
    let args: Vec<Val> = (
        f.booking_id.clone(),
        f.professional.clone(),
        f.client.clone(),
        f.token.clone(),
        f.amount,
        f.cancel_deadline,
    )
        .into_val(&f.env);

    // The professional signing the same call does not authorize it.
    f.env.mock_auths(&[MockAuth {
        address: &f.professional,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "create_booking",
            args: args.clone(),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(f.create(), Err(Err(InvokeError::Abort)));
    assert_no_effect(&f, 1_000_000_000);

    // The client's own signature for that same call does.
    f.env.mock_auths(&[MockAuth {
        address: &f.client,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "create_booking",
            args,
            sub_invokes: &[MockAuthInvoke {
                contract: &f.token,
                fn_name: "transfer",
                args: (f.client.clone(), f.contract_id.clone(), f.amount).into_val(&f.env),
                sub_invokes: &[],
            }],
        },
    }]);
    assert_eq!(f.create(), Ok(Ok(())));
    assert_eq!(f.token_client().balance(&f.contract_id), f.amount);
}

/// The Stellar Asset Contract's `BalanceError`, raised when a transfer would
/// take a balance below zero. Numbered in the host, not in this crate:
/// `soroban_env_host::builtin_contracts::contract_error::ContractError::BalanceError = 10`.
const SAC_BALANCE_ERROR: u32 = 10;

// Matrix row: client cannot cover the amount. The token contract's own error
// propagates and aborts the call, so nothing is stored.
#[test]
fn an_underfunded_client_cannot_lock_a_deposit() {
    // Funded with one unit less than the deposit.
    let f = Fixture::new(250_000_000 - 1);

    // Pinned to the token's insufficient-balance error specifically: accepting
    // any host error would also accept an auth failure or a panic in this
    // contract, which is the opposite of what this row is about.
    assert_eq!(
        f.create(),
        Err(Err(InvokeError::Contract(SAC_BALANCE_ERROR)))
    );

    assert_no_effect(&f, 250_000_000 - 1);
}

/// A rejected call moved no tokens, stored no booking and emitted no event.
///
/// The event check comes first because `events().all()` only ever describes the
/// most recent contract invocation, and reading a balance is one — asking after
/// a balance read would find an empty list whatever `create_booking` did. Note
/// this assertion alone is weak evidence: the host discards the events of a
/// failed invocation anyway. The storage and balance checks below are what
/// actually show nothing happened.
fn assert_no_effect(f: &Fixture, funding: i128) {
    assert!(
        f.own_events().events().is_empty(),
        "a rejected call emitted an event"
    );
    let token = f.token_client();
    assert_eq!(token.balance(&f.contract_id), 0, "tokens moved");
    assert_eq!(
        token.balance(&f.client),
        funding,
        "the client's balance moved"
    );
    f.env.as_contract(&f.contract_id, || {
        assert!(
            !storage::has_booking(&f.env, &f.booking_id),
            "a rejected call wrote a booking"
        );
    });
}
