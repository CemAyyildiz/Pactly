#![cfg(test)]

use soroban_sdk::{
    symbol_short,
    testutils::{
        storage::Persistent as _, Address as _, BytesN as _, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, ConversionError, Env, IntoVal, InvokeError, Symbol, Val, Vec,
};

use crate::storage::{self, DataKey, BUMP_LEDGERS, BUMP_THRESHOLD_LEDGERS};
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

/// What every `try_*` entry point returns: `Ok(Ok(()))` on success,
/// `Err(Ok(error))` for a contract error, `Err(Err(..))` for a host error such
/// as a failed `require_auth` or a token contract that trapped. One alias for
/// all of them, so a change to the client's error representation is made once.
type CallResult = Result<Result<(), ConversionError>, Result<Error, InvokeError>>;

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

    fn create(&self) -> CallResult {
        self.client_contract.try_create_booking(
            &self.booking_id,
            &self.professional,
            &self.client,
            &self.token,
            &self.amount,
            &self.cancel_deadline,
        )
    }

    fn release(&self) -> CallResult {
        self.client_contract.try_release(&self.booking_id)
    }

    fn cancel_by_professional(&self) -> CallResult {
        self.client_contract
            .try_cancel_by_professional(&self.booking_id)
    }

    fn cancel_by_client(&self) -> CallResult {
        self.client_contract.try_cancel_by_client(&self.booking_id)
    }

    fn claim_no_show(&self) -> CallResult {
        self.client_contract.try_claim_no_show(&self.booking_id)
    }

    fn token_client(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }

    /// Only the escrow's own events; the token contract emits its own transfer.
    fn own_events(&self) -> soroban_sdk::testutils::ContractEvents {
        self.env.events().all().filter_by_contract(&self.contract_id)
    }

    /// The one money event this fixture's booking produces under `name`.
    ///
    /// All five money events share a wire shape by design — topics
    /// `(name, booking_id)`, data `amount` — so one builder describes every one
    /// of them, and a divergence in any would fail here.
    fn expected_event(&self, name: Symbol) -> Vec<(Address, Vec<Val>, Val)> {
        let topics: Vec<Val> = (name, self.booking_id.clone()).into_val(&self.env);
        vec![
            &self.env,
            (
                self.contract_id.clone(),
                topics,
                self.amount.into_val(&self.env),
            ),
        ]
    }

    fn expected_locked_event(&self) -> Vec<(Address, Vec<Val>, Val)> {
        self.expected_event(symbol_short!("locked"))
    }

    fn expected_released_event(&self) -> Vec<(Address, Vec<Val>, Val)> {
        self.expected_event(symbol_short!("released"))
    }

    fn expected_refunded_event(&self) -> Vec<(Address, Vec<Val>, Val)> {
        self.expected_event(symbol_short!("refunded"))
    }

    fn expected_cancelled_event(&self) -> Vec<(Address, Vec<Val>, Val)> {
        self.expected_event(symbol_short!("cancelled"))
    }

    fn expected_forfeited_event(&self) -> Vec<(Address, Vec<Val>, Val)> {
        self.expected_event(symbol_short!("forfeited"))
    }

    /// Everything a rejected call must leave exactly as it found it.
    fn snapshot(&self) -> Snapshot {
        let token = self.token_client();
        Snapshot {
            escrow: token.balance(&self.contract_id),
            professional: token.balance(&self.professional),
            client: token.balance(&self.client),
            booking: self.env.as_contract(&self.contract_id, || {
                storage::get_booking(&self.env, &self.booking_id).ok()
            }),
        }
    }
}

/// The three balances and the stored record at one point in time.
#[derive(Debug, Eq, PartialEq)]
struct Snapshot {
    escrow: i128,
    professional: i128,
    client: i128,
    /// `None` when nothing is stored under the fixture's booking id.
    booking: Option<Booking>,
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
    assert_eq!(Error::TooEarly as u32, 9);
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
// life after its deadline — the window `claim_no_show` acts in.
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
// contract itself could not be reached by any settlement path.
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

// ---------------------------------------------------------------------------
// Story 1.4 — release
// ---------------------------------------------------------------------------

/// How much the fixture's client starts with, and what every balance assertion
/// in this section is measured against.
const FUNDING: i128 = 1_000_000_000;

/// A fixture whose deposit is already locked — `release`'s only precondition.
fn locked_fixture() -> Fixture {
    let f = Fixture::new(FUNDING);
    f.create().unwrap().unwrap();
    f
}

/// A rejected settlement moved no tokens and left the record exactly as it was.
///
/// Shared by all four settlement paths — `release` and Story 1.5's three — since
/// what a rejected call must leave behind is the same for every one of them.
///
/// `before` is taken *before* the call. The event check comes first because
/// `events().all()` only ever describes the most recent contract invocation, and
/// reading a balance is one; on its own it is also weak evidence, since the host
/// discards a failed invocation's events anyway. The snapshot comparison is what
/// actually shows nothing happened.
fn assert_nothing_changed(f: &Fixture, before: &Snapshot) {
    assert!(
        f.own_events().events().is_empty(),
        "a rejected call emitted an event"
    );
    assert_eq!(
        f.snapshot(),
        *before,
        "a rejected call moved tokens or rewrote the record"
    );
}

// Matrix row: deposit released.
#[test]
fn deposit_is_released_and_the_professional_is_paid() {
    let f = locked_fixture();

    assert_eq!(f.release(), Ok(Ok(())));

    // The `released` event carries the booking id in its topics and the amount
    // as data — `locked`'s shape exactly. Checked first: `events().all()` only
    // covers the last invocation, and reading a balance is one.
    assert_eq!(f.own_events(), f.expected_released_event());

    // The professional holds exactly the deposit and the escrow holds nothing
    // for it: no fee, no cut, no partial release.
    let token = f.token_client();
    assert_eq!(token.balance(&f.professional), f.amount);
    assert_eq!(
        token.balance(&f.contract_id),
        0,
        "the escrow still holds the deposit"
    );
    assert_eq!(token.balance(&f.client), FUNDING - f.amount);

    // Only `state` moved; every other field is as it was stored.
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
                state: BookingState::Released,
            }
        );
    });
}

// `release`'s own TTL bump is covered by
// `every_settlement_path_bumps_the_bookings_ttl`, which runs this same check
// over all four settlement paths.

// Matrix row: unknown booking id.
#[test]
fn releasing_an_unknown_booking_id_is_rejected_and_changes_nothing() {
    let f = locked_fixture();
    let before = f.snapshot();

    let unknown_id = BytesN::from_array(&f.env, &[0x77; 16]);

    assert_eq!(
        f.client_contract.try_release(&unknown_id),
        Err(Ok(Error::BookingNotFound))
    );

    assert_nothing_changed(&f, &before);
    // The snapshot only watches the fixture's own id, so the id that was asked
    // for needs its own check: a rejected call must not have created it either.
    f.env.as_contract(&f.contract_id, || {
        assert!(
            !storage::has_booking(&f.env, &unknown_id),
            "a rejected release wrote a booking under the unknown id"
        );
    });
}

// `release` must read the record before it can know whose signature to demand,
// so an unknown id is answerable without one. Deliberate, not accidental:
// booking ids are generated off chain and carry no secret.
#[test]
fn an_unknown_booking_id_is_reported_without_any_authorization() {
    let f = locked_fixture();
    let before = f.snapshot();
    // Switch from `mock_all_auths` to enforcing auth with no signatures supplied.
    f.env.set_auths(&[]);

    let unknown_id = BytesN::from_array(&f.env, &[0x77; 16]);

    assert_eq!(
        f.client_contract.try_release(&unknown_id),
        Err(Ok(Error::BookingNotFound))
    );

    // What it may disclose is the id's absence — never anyone's money.
    assert_nothing_changed(&f, &before);
}

// Matrix row: already released.
#[test]
fn releasing_an_already_released_booking_is_rejected_and_changes_nothing() {
    let f = locked_fixture();
    f.release().unwrap().unwrap();

    let before = f.snapshot();

    assert_eq!(f.release(), Err(Ok(Error::InvalidState)));

    assert_nothing_changed(&f, &before);
    assert_eq!(
        before.booking.as_ref().map(|b| b.state),
        Some(BookingState::Released),
        "the record should still read Released"
    );
}

// Matrix row: released twice in a row. The state check is what stands between a
// repeated call and a second payout.
#[test]
fn releasing_twice_pays_the_professional_exactly_once() {
    let f = locked_fixture();

    assert_eq!(f.release(), Ok(Ok(())));
    assert_eq!(f.release(), Err(Ok(Error::InvalidState)));

    assert!(
        f.own_events().events().is_empty(),
        "the second release emitted an event"
    );

    let token = f.token_client();
    assert_eq!(
        token.balance(&f.professional),
        f.amount,
        "the professional was paid more than once"
    );
    assert_eq!(token.balance(&f.contract_id), 0);
    assert_eq!(token.balance(&f.client), FUNDING - f.amount);
}

// Matrix row: already refunded. Story 1.5 owns the refund path, so the terminal
// state is written directly here — what this row is about is that `release`
// refuses it, not how the booking got there.
#[test]
fn releasing_a_refunded_booking_is_rejected_and_changes_nothing() {
    let f = locked_fixture();
    f.env.as_contract(&f.contract_id, || {
        let mut booking = storage::get_booking(&f.env, &f.booking_id).unwrap();
        booking.state = BookingState::Refunded;
        storage::set_booking(&f.env, &f.booking_id, &booking);
    });

    let before = f.snapshot();

    assert_eq!(f.release(), Err(Ok(Error::InvalidState)));

    assert_nothing_changed(&f, &before);
}

// Matrix row: client did not authorize. Covered by
// `no_settlement_path_moves_money_without_a_signature`, which runs the unsigned
// call over all four settlement paths.

// Matrix row: someone else authorizes. Only the client recorded on the booking
// can release it — not the payee, and not the platform's own key.
#[test]
fn only_the_clients_own_authorization_releases_the_deposit() {
    let f = locked_fixture();
    let before = f.snapshot();
    let args: Vec<Val> = (f.booking_id.clone(),).into_val(&f.env);

    // The professional signing the same call does not authorize it: the payee
    // must never be able to pay themselves.
    f.env.mock_auths(&[MockAuth {
        address: &f.professional,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "release",
            args: args.clone(),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(f.release(), Err(Err(InvokeError::Abort)));
    assert_nothing_changed(&f, &before);

    // Nor does a third party's — the backend's signing key, in practice.
    let stranger = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "release",
            args: args.clone(),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(f.release(), Err(Err(InvokeError::Abort)));
    assert_nothing_changed(&f, &before);

    // The client's own signature for that same call does. The payout itself
    // needs no signature: the escrow is paying from its own address.
    f.env.mock_auths(&[MockAuth {
        address: &f.client,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "release",
            args,
            sub_invokes: &[],
        },
    }]);
    assert_eq!(f.release(), Ok(Ok(())));
    assert_eq!(f.own_events(), f.expected_released_event());
    let token = f.token_client();
    assert_eq!(token.balance(&f.professional), f.amount);
    assert_eq!(
        token.balance(&f.contract_id),
        0,
        "the escrow still holds the deposit"
    );
    f.env.as_contract(&f.contract_id, || {
        assert_eq!(
            storage::get_booking(&f.env, &f.booking_id).unwrap().state,
            BookingState::Released
        );
    });
}

// Story 1.5 owns the deadline: `release` deliberately makes no comparison
// against it, so a client who settles late still pays their professional.
// Without this test a deadline guard could be added to `release` and the whole
// suite would stay green.
#[test]
fn a_deposit_is_still_releasable_after_the_cancel_deadline() {
    let f = locked_fixture();
    f.env.ledger().set_timestamp(f.cancel_deadline + 1);

    assert_eq!(f.release(), Ok(Ok(())));

    assert_eq!(f.own_events(), f.expected_released_event());
    assert_eq!(f.token_client().balance(&f.professional), f.amount);
    f.env.as_contract(&f.contract_id, || {
        assert_eq!(
            storage::get_booking(&f.env, &f.booking_id).unwrap().state,
            BookingState::Released
        );
    });
}

// A signed client is the only party who may learn whether their own booking is
// still releasable, so a terminal state must not be reported to an unsigned
// caller — the ordering mirrors `initialize`.
#[test]
fn release_checks_authorization_before_the_state_check() {
    let f = locked_fixture();
    f.release().unwrap().unwrap();

    let before = f.snapshot();

    // Switch to enforcing auth with no signatures supplied.
    f.env.set_auths(&[]);

    assert_eq!(
        f.release(),
        Err(Err(InvokeError::Abort)),
        "expected the host auth error, not Error::InvalidState"
    );

    assert_nothing_changed(&f, &before);
}

// Bookings settle one at a time: releasing one pays its own professional and
// leaves every other deposit in the contract's custody.
#[test]
fn releasing_one_booking_leaves_another_untouched() {
    let f = locked_fixture();

    let second_id = BytesN::from_array(&f.env, &[0x2e; 16]);
    let second_amount = 75_000_000_i128;
    let second_professional = Address::generate(&f.env);
    f.client_contract.create_booking(
        &second_id,
        &second_professional,
        &f.client,
        &f.token,
        &second_amount,
        &(f.cancel_deadline + 3_600),
    );

    assert_eq!(f.release(), Ok(Ok(())));

    let token = f.token_client();
    assert_eq!(token.balance(&f.professional), f.amount);
    assert_eq!(token.balance(&second_professional), 0);
    assert_eq!(
        token.balance(&f.contract_id),
        second_amount,
        "the other booking's deposit left the escrow"
    );

    f.env.as_contract(&f.contract_id, || {
        assert_eq!(
            storage::get_booking(&f.env, &second_id).unwrap().state,
            BookingState::Locked
        );
    });
}

// ---------------------------------------------------------------------------
// Story 1.5 — cancel_by_professional, cancel_by_client, claim_no_show
// ---------------------------------------------------------------------------

/// The three paths this story adds, for the matrix rows that hold for all of
/// them. `release` joins them in [`EVERY_SETTLEMENT_PATH`] where the row covers
/// every way a deposit can leave the escrow.
const CANCELLATION_PATHS: [(&str, fn(&Fixture) -> CallResult); 3] = [
    ("cancel_by_professional", Fixture::cancel_by_professional),
    ("cancel_by_client", Fixture::cancel_by_client),
    ("claim_no_show", Fixture::claim_no_show),
];

/// Every way a deposit leaves the escrow: the three above plus `release`.
const EVERY_SETTLEMENT_PATH: [(&str, fn(&Fixture) -> CallResult); 4] = [
    ("cancel_by_professional", Fixture::cancel_by_professional),
    ("cancel_by_client", Fixture::cancel_by_client),
    ("claim_no_show", Fixture::claim_no_show),
    ("release", Fixture::release),
];

/// The stored record, asserted field by field against the fixture's inputs with
/// only `state` allowed to have moved.
fn assert_only_the_state_moved(f: &Fixture, state: BookingState) {
    f.env.as_contract(&f.contract_id, || {
        assert_eq!(
            storage::get_booking(&f.env, &f.booking_id).unwrap(),
            Booking {
                professional: f.professional.clone(),
                client: f.client.clone(),
                token: f.token.clone(),
                amount: f.amount,
                cancel_deadline: f.cancel_deadline,
                state,
            }
        );
    });
}

/// The client's balance is whole again, the escrow holds nothing for this
/// booking and the professional was paid nothing: no fee, no cut, no partial
/// refund. Reads balances, so it runs *after* any event assertion.
fn assert_the_client_was_made_whole(f: &Fixture) {
    let token = f.token_client();
    assert_eq!(token.balance(&f.client), FUNDING, "the client is short");
    assert_eq!(
        token.balance(&f.contract_id),
        0,
        "the escrow still holds the deposit"
    );
    assert_eq!(
        token.balance(&f.professional),
        0,
        "the professional was paid out of a refund"
    );
}

/// The professional holds the whole deposit, the escrow holds nothing for this
/// booking and the client is out of pocket by exactly it. Reads balances, so it
/// runs *after* any event assertion.
fn assert_the_professional_was_paid(f: &Fixture) {
    let token = f.token_client();
    assert_eq!(
        token.balance(&f.professional),
        f.amount,
        "the professional was not paid the whole deposit"
    );
    assert_eq!(
        token.balance(&f.contract_id),
        0,
        "the escrow still holds the deposit"
    );
    assert_eq!(
        token.balance(&f.client),
        FUNDING - f.amount,
        "the client's balance moved by something other than the deposit"
    );
}

// Matrix row: professional cancels early.
#[test]
fn a_professional_cancelling_before_the_deadline_refunds_the_client() {
    let f = locked_fixture();
    f.env.ledger().set_timestamp(f.cancel_deadline - 1);

    assert_eq!(f.cancel_by_professional(), Ok(Ok(())));

    // `cancelled`, not `refunded`: the provider's cancellation count is derived
    // from this name alone. Checked first — `events().all()` only covers the
    // last invocation, and reading a balance is one.
    assert_eq!(f.own_events(), f.expected_cancelled_event());

    assert_the_client_was_made_whole(&f);
    assert_only_the_state_moved(&f, BookingState::Refunded);
}

// Matrix row: professional cancels late. The clock never applies to this path —
// a passed deadline ends the *client's* free-cancellation window and says
// nothing about what the professional owes.
#[test]
fn a_professional_cancelling_after_the_deadline_still_refunds_the_client() {
    // Just past it, and long past it: neither is a reason to pay the
    // professional for a session they called off themselves.
    for timestamp in [NOW + 86_400 + 1, NOW + 86_400 + SETTLEMENT_MARGIN_SECONDS] {
        let f = locked_fixture();
        assert!(timestamp > f.cancel_deadline);
        f.env.ledger().set_timestamp(timestamp);

        assert_eq!(f.cancel_by_professional(), Ok(Ok(())), "at {timestamp}");

        assert_eq!(f.own_events(), f.expected_cancelled_event());
        assert_the_client_was_made_whole(&f);
        assert_only_the_state_moved(&f, BookingState::Refunded);
    }
}

// Matrix row: client cancels in time.
#[test]
fn a_client_cancelling_before_the_deadline_is_refunded() {
    let f = locked_fixture();
    f.env.ledger().set_timestamp(f.cancel_deadline - 1);

    assert_eq!(f.cancel_by_client(), Ok(Ok(())));

    assert_eq!(f.own_events(), f.expected_refunded_event());
    assert_the_client_was_made_whole(&f);
    assert_only_the_state_moved(&f, BookingState::Refunded);
}

// Matrix row: client cancels on the boundary. The deadline is published to the
// client as the end of their free-cancellation window, so the window has to
// include the second it names.
#[test]
fn a_client_cancelling_exactly_on_the_deadline_is_refunded() {
    let f = locked_fixture();
    f.env.ledger().set_timestamp(f.cancel_deadline);

    assert_eq!(f.cancel_by_client(), Ok(Ok(())));

    assert_eq!(f.own_events(), f.expected_refunded_event());
    assert_the_client_was_made_whole(&f);
    assert_only_the_state_moved(&f, BookingState::Refunded);
}

// Matrix row: client cancels late. One second past the deadline the deposit is
// forfeit — and the event is `forfeited`, never `released`, or the professional
// would be credited with a session they never held.
#[test]
fn a_client_cancelling_after_the_deadline_forfeits_the_deposit() {
    let f = locked_fixture();
    f.env.ledger().set_timestamp(f.cancel_deadline + 1);

    assert_eq!(f.cancel_by_client(), Ok(Ok(())));

    assert_eq!(f.own_events(), f.expected_forfeited_event());
    assert_the_professional_was_paid(&f);
    assert_only_the_state_moved(&f, BookingState::Released);
}

// Matrix row: no-show claimed. The same outcome a late client cancellation
// produces, down to the event name: either the client admits the late
// cancellation or the professional claims the silence, and the deposit is
// forfeit the same way.
#[test]
fn a_no_show_claimed_after_the_deadline_forfeits_the_deposit() {
    let f = locked_fixture();
    f.env.ledger().set_timestamp(f.cancel_deadline + 1);

    assert_eq!(f.claim_no_show(), Ok(Ok(())));

    assert_eq!(f.own_events(), f.expected_forfeited_event());
    assert_the_professional_was_paid(&f);
    assert_only_the_state_moved(&f, BookingState::Released);
}

// Matrix row: no-show claimed too early. While the client may still cancel for
// free, the professional may not claim — including on the boundary second,
// which belongs to the client on both paths.
#[test]
fn a_no_show_claimed_before_the_deadline_is_rejected_as_too_early() {
    let f = locked_fixture();
    let before = f.snapshot();

    for timestamp in [NOW, f.cancel_deadline - 1, f.cancel_deadline] {
        f.env.ledger().set_timestamp(timestamp);

        assert_eq!(
            f.claim_no_show(),
            Err(Ok(Error::TooEarly)),
            "at {timestamp}"
        );

        assert_nothing_changed(&f, &before);
    }

    // And the very next second the same call goes all the way through, so the
    // refusals above were the clock and nothing else.
    f.env.ledger().set_timestamp(f.cancel_deadline + 1);
    assert_eq!(f.claim_no_show(), Ok(Ok(())));

    assert_eq!(f.own_events(), f.expected_forfeited_event());
    assert_the_professional_was_paid(&f);
    assert_only_the_state_moved(&f, BookingState::Released);
}

// Matrix row: wrong party signs. `cancel_by_professional` moves the deposit back
// to the client, so only the professional recorded on the booking may call it —
// not the client, who would otherwise refund themselves past their own deadline.
#[test]
fn only_the_professionals_own_authorization_cancels_by_professional() {
    let f = locked_fixture();
    let before = f.snapshot();
    let args: Vec<Val> = (f.booking_id.clone(),).into_val(&f.env);

    for signer in [f.client.clone(), Address::generate(&f.env)] {
        f.env.mock_auths(&[MockAuth {
            address: &signer,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "cancel_by_professional",
                args: args.clone(),
                sub_invokes: &[],
            },
        }]);
        assert_eq!(f.cancel_by_professional(), Err(Err(InvokeError::Abort)));
        assert_nothing_changed(&f, &before);
    }

    // The professional's own signature for that same call does. The payout
    // itself needs no signature: the escrow is paying from its own address.
    f.env.mock_auths(&[MockAuth {
        address: &f.professional,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_by_professional",
            args,
            sub_invokes: &[],
        },
    }]);
    assert_eq!(f.cancel_by_professional(), Ok(Ok(())));
    assert_eq!(f.own_events(), f.expected_cancelled_event());
    assert_the_client_was_made_whole(&f);
}

// Matrix row: wrong party signs. Only the client recorded on the booking may
// cancel on the client's side — a professional who could call it before the
// deadline would be refunding their own client's deposit in their name.
#[test]
fn only_the_clients_own_authorization_cancels_by_client() {
    let f = locked_fixture();
    let before = f.snapshot();
    let args: Vec<Val> = (f.booking_id.clone(),).into_val(&f.env);

    for signer in [f.professional.clone(), Address::generate(&f.env)] {
        f.env.mock_auths(&[MockAuth {
            address: &signer,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "cancel_by_client",
                args: args.clone(),
                sub_invokes: &[],
            },
        }]);
        assert_eq!(f.cancel_by_client(), Err(Err(InvokeError::Abort)));
        assert_nothing_changed(&f, &before);
    }

    f.env.mock_auths(&[MockAuth {
        address: &f.client,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_by_client",
            args,
            sub_invokes: &[],
        },
    }]);
    assert_eq!(f.cancel_by_client(), Ok(Ok(())));
    assert_eq!(f.own_events(), f.expected_refunded_event());
    assert_the_client_was_made_whole(&f);
}

// Matrix row: wrong party signs. A client cannot forfeit their own deposit by
// claiming they were a no-show, and no third party can claim it for anybody.
#[test]
fn only_the_professionals_own_authorization_claims_a_no_show() {
    let f = locked_fixture();
    f.env.ledger().set_timestamp(f.cancel_deadline + 1);
    let before = f.snapshot();
    let args: Vec<Val> = (f.booking_id.clone(),).into_val(&f.env);

    for signer in [f.client.clone(), Address::generate(&f.env)] {
        f.env.mock_auths(&[MockAuth {
            address: &signer,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "claim_no_show",
                args: args.clone(),
                sub_invokes: &[],
            },
        }]);
        assert_eq!(f.claim_no_show(), Err(Err(InvokeError::Abort)));
        assert_nothing_changed(&f, &before);
    }

    f.env.mock_auths(&[MockAuth {
        address: &f.professional,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "claim_no_show",
            args,
            sub_invokes: &[],
        },
    }]);
    assert_eq!(f.claim_no_show(), Ok(Ok(())));
    assert_eq!(f.own_events(), f.expected_forfeited_event());
    assert_the_professional_was_paid(&f);
}

// Matrix row: nobody signs. No settlement path is permissionless, `release`
// included, so the platform's own key — which signs nothing on a booking's
// behalf — can call none of them.
#[test]
fn no_settlement_path_moves_money_without_a_signature() {
    let f = locked_fixture();
    let before = f.snapshot();

    // Switch from `mock_all_auths` to enforcing auth with no signatures supplied.
    f.env.set_auths(&[]);

    // Past the deadline, so the clock is no part of why `claim_no_show` is
    // refused, and the others are unaffected by where it sits.
    f.env.ledger().set_timestamp(f.cancel_deadline + 1);

    for (name, call) in EVERY_SETTLEMENT_PATH {
        // A host auth error (`Err(Err(..))`), not a contract error.
        assert_eq!(
            call(&f),
            Err(Err(InvokeError::Abort)),
            "{name} ran unsigned"
        );
        assert_nothing_changed(&f, &before);
    }
}

// A party to the booking is the only one who may learn whether it is still
// settleable, so a terminal state must not be reported to an unsigned caller —
// the ordering `release_checks_authorization_before_the_state_check` pins for
// `release`, here for the three paths this story adds. Without this, moving the
// state guard above `require_auth` would break nothing.
#[test]
fn every_cancellation_path_checks_authorization_before_the_state_check() {
    for (name, call) in CANCELLATION_PATHS {
        let f = locked_fixture();
        // Settle it first, so every path below has a terminal state to report.
        f.release().unwrap().unwrap();

        let before = f.snapshot();

        // Past the deadline, so `claim_no_show` is ripe and the state check is
        // the only contract error it could return.
        f.env.ledger().set_timestamp(f.cancel_deadline + 1);

        // Switch to enforcing auth with no signatures supplied.
        f.env.set_auths(&[]);

        assert_eq!(
            call(&f),
            Err(Err(InvokeError::Abort)),
            "{name}: expected the host auth error, not Error::InvalidState"
        );

        assert_nothing_changed(&f, &before);
    }
}

// `claim_no_show` has a second check behind its auth: auth must sit in front of
// the clock too, or an unsigned caller could probe whether a booking's
// free-cancellation window has closed.
#[test]
fn claim_no_show_checks_authorization_before_the_clock() {
    let f = locked_fixture();
    let before = f.snapshot();

    // Inside the window, where a signed claim would be refused as TooEarly.
    assert!(f.env.ledger().timestamp() <= f.cancel_deadline);

    // Switch to enforcing auth with no signatures supplied.
    f.env.set_auths(&[]);

    assert_eq!(
        f.claim_no_show(),
        Err(Err(InvokeError::Abort)),
        "expected the host auth error, not Error::TooEarly"
    );

    assert_nothing_changed(&f, &before);
}

// Matrix row: unknown booking id. Every path has to read the record before it
// knows whose signature to demand, so an unknown id is answerable without one —
// booking ids are off-chain ULIDs and carry no secret.
#[test]
fn settling_an_unknown_booking_id_is_rejected_and_changes_nothing() {
    let f = locked_fixture();
    let before = f.snapshot();
    let unknown_id = BytesN::from_array(&f.env, &[0x77; 16]);

    // Enforcing auth with no signatures supplied: the absence of the id is all
    // this may disclose, and it is disclosed without anyone signing.
    f.env.set_auths(&[]);

    assert_eq!(
        f.client_contract.try_cancel_by_professional(&unknown_id),
        Err(Ok(Error::BookingNotFound))
    );
    assert_nothing_changed(&f, &before);

    assert_eq!(
        f.client_contract.try_cancel_by_client(&unknown_id),
        Err(Ok(Error::BookingNotFound))
    );
    assert_nothing_changed(&f, &before);

    assert_eq!(
        f.client_contract.try_claim_no_show(&unknown_id),
        Err(Ok(Error::BookingNotFound))
    );
    assert_nothing_changed(&f, &before);

    // The snapshot only watches the fixture's own id, so the id that was asked
    // for needs its own check: a rejected call must not have created it either.
    f.env.as_contract(&f.contract_id, || {
        assert!(
            !storage::has_booking(&f.env, &unknown_id),
            "a rejected settlement wrote a booking under the unknown id"
        );
    });
}

// Matrix row: already released. `Released` is terminal for every path, and the
// state check runs before the clock — a no-show claim on a released booking is
// an illegal state, not a timing problem.
#[test]
fn every_path_rejects_an_already_released_booking() {
    let f = locked_fixture();
    f.release().unwrap().unwrap();

    let before = f.snapshot();
    assert_eq!(
        before.booking.as_ref().map(|b| b.state),
        Some(BookingState::Released)
    );

    // The clock sits inside the free-cancellation window, where an unsettled
    // `claim_no_show` would answer `TooEarly` instead.
    assert!(f.env.ledger().timestamp() < f.cancel_deadline);

    for (name, call) in EVERY_SETTLEMENT_PATH {
        assert_eq!(call(&f), Err(Ok(Error::InvalidState)), "{name}");
        assert_nothing_changed(&f, &before);
    }
}

// Matrix row: already refunded. The mirror of the row above, reached through a
// real refund rather than a hand-written record.
#[test]
fn every_path_rejects_an_already_refunded_booking() {
    let f = locked_fixture();
    f.cancel_by_professional().unwrap().unwrap();

    let before = f.snapshot();
    assert_eq!(
        before.booking.as_ref().map(|b| b.state),
        Some(BookingState::Refunded)
    );

    for (name, call) in EVERY_SETTLEMENT_PATH {
        assert_eq!(call(&f), Err(Ok(Error::InvalidState)), "{name}");
        assert_nothing_changed(&f, &before);
    }
}

// Matrix row: settled twice. The state check is what stands between a repeated
// call and a second payout — checked on each path's own success, since each
// writes its own terminal state.
#[test]
fn a_settled_booking_moves_its_deposit_exactly_once() {
    // A professional's cancellation, then the same call again.
    let f = locked_fixture();
    assert_eq!(f.cancel_by_professional(), Ok(Ok(())));
    assert_eq!(f.cancel_by_professional(), Err(Ok(Error::InvalidState)));
    assert!(
        f.own_events().events().is_empty(),
        "the second cancellation emitted an event"
    );
    assert_the_client_was_made_whole(&f);

    // An on-time client cancellation, then the same call again.
    let g = locked_fixture();
    assert_eq!(g.cancel_by_client(), Ok(Ok(())));
    assert_eq!(g.cancel_by_client(), Err(Ok(Error::InvalidState)));
    assert!(
        g.own_events().events().is_empty(),
        "the second client cancellation emitted an event"
    );
    assert_the_client_was_made_whole(&g);

    // A no-show claim, then the same call again — still ripe by the clock, and
    // still refused.
    let h = locked_fixture();
    h.env.ledger().set_timestamp(h.cancel_deadline + 1);
    assert_eq!(h.claim_no_show(), Ok(Ok(())));
    assert_eq!(h.claim_no_show(), Err(Ok(Error::InvalidState)));
    assert!(
        h.own_events().events().is_empty(),
        "the second no-show claim emitted an event"
    );
    assert_the_professional_was_paid(&h);

    // A late client cancellation, then the professional claiming the same
    // booking as a no-show: the deposit is already forfeit and moves no further.
    let i = locked_fixture();
    i.env.ledger().set_timestamp(i.cancel_deadline + 1);
    assert_eq!(i.cancel_by_client(), Ok(Ok(())));
    assert_eq!(i.claim_no_show(), Err(Ok(Error::InvalidState)));
    assert!(
        i.own_events().events().is_empty(),
        "the no-show claim after a late cancellation emitted an event"
    );
    assert_the_professional_was_paid(&i);
}

// Every settlement write must bump the TTL, or a settled record could be
// archived while the backend still needs to read the outcome.
#[test]
fn every_settlement_path_bumps_the_bookings_ttl() {
    for (name, call) in EVERY_SETTLEMENT_PATH {
        let f = locked_fixture();
        // Past the deadline, where all four are legal: a refund by the
        // professional, a forfeit by the client, a ripe no-show claim, and a
        // release, which never consults the clock at all.
        f.env.ledger().set_timestamp(f.cancel_deadline + 1);

        // Advance past the bump threshold first: straight after `create_booking`
        // the TTL is already at its ceiling, so a path that never bumped would
        // still look correct.
        let sequence = f.env.ledger().sequence();
        f.env
            .ledger()
            .set_sequence_number(sequence + 2 * (BUMP_LEDGERS - BUMP_THRESHOLD_LEDGERS));

        let key = DataKey::Booking(f.booking_id.clone());
        f.env.as_contract(&f.contract_id, || {
            assert!(
                f.env.storage().persistent().get_ttl(&key) < BUMP_THRESHOLD_LEDGERS,
                "{name}: the entry was not yet due for a bump, so this proves nothing"
            );
        });

        assert_eq!(call(&f), Ok(Ok(())), "{name}");

        f.env.as_contract(&f.contract_id, || {
            assert_eq!(
                f.env.storage().persistent().get_ttl(&key),
                BUMP_LEDGERS,
                "{name}"
            );
        });
    }
}

// `released` means the client confirmed the session: Story 4.3's verified
// session counter increments on that name alone. None of the four outcomes
// added here may emit it — a no-show that did would be counted as a session the
// professional held.
//
// Each assertion below pins an outcome to one exact event, and `own_events()`
// returns everything the escrow emitted during that invocation, so a path that
// emitted `released` — instead of its own name or alongside it — fails here.
// That equality is what carries the claim; a companion `assert_ne!` against the
// `released` event would be implied by it and could never fail on its own.
#[test]
fn released_is_emitted_by_release_alone() {
    // A professional's cancellation.
    let a = locked_fixture();
    a.cancel_by_professional().unwrap().unwrap();
    assert_eq!(a.own_events(), a.expected_cancelled_event());

    // An on-time client cancellation.
    let b = locked_fixture();
    b.cancel_by_client().unwrap().unwrap();
    assert_eq!(b.own_events(), b.expected_refunded_event());

    // A late client cancellation — pays the professional, but is not a session.
    let c = locked_fixture();
    c.env.ledger().set_timestamp(c.cancel_deadline + 1);
    c.cancel_by_client().unwrap().unwrap();
    assert_eq!(c.own_events(), c.expected_forfeited_event());

    // A claimed no-show — likewise.
    let d = locked_fixture();
    d.env.ledger().set_timestamp(d.cancel_deadline + 1);
    d.claim_no_show().unwrap().unwrap();
    assert_eq!(d.own_events(), d.expected_forfeited_event());

    // And `release` itself still does emit it.
    let e = locked_fixture();
    e.release().unwrap().unwrap();
    assert_eq!(e.own_events(), e.expected_released_event());
}

// Bookings settle one at a time: a refund returns its own deposit and leaves
// every other one in the contract's custody.
#[test]
fn cancelling_one_booking_leaves_another_untouched() {
    let f = locked_fixture();

    let second_id = BytesN::from_array(&f.env, &[0x2e; 16]);
    let second_amount = 75_000_000_i128;
    let second_professional = Address::generate(&f.env);
    f.client_contract.create_booking(
        &second_id,
        &second_professional,
        &f.client,
        &f.token,
        &second_amount,
        &(f.cancel_deadline + 3_600),
    );

    assert_eq!(f.cancel_by_professional(), Ok(Ok(())));

    let token = f.token_client();
    assert_eq!(token.balance(&f.client), FUNDING - second_amount);
    assert_eq!(
        token.balance(&f.contract_id),
        second_amount,
        "the other booking's deposit left the escrow"
    );
    assert_eq!(token.balance(&f.professional), 0);
    assert_eq!(token.balance(&second_professional), 0);

    f.env.as_contract(&f.contract_id, || {
        assert_eq!(
            storage::get_booking(&f.env, &second_id).unwrap().state,
            BookingState::Locked
        );
    });
}

// The same for a forfeit, which pays out rather than refunds — and the other
// booking's own deadline is still ahead, so one deposit being claimable says
// nothing about the next.
#[test]
fn claiming_one_no_show_leaves_another_booking_untouched() {
    let f = locked_fixture();

    let second_id = BytesN::from_array(&f.env, &[0x2e; 16]);
    let second_amount = 75_000_000_i128;
    let second_deadline = f.cancel_deadline + 3_600;
    f.client_contract.create_booking(
        &second_id,
        &f.professional,
        &f.client,
        &f.token,
        &second_amount,
        &second_deadline,
    );

    f.env.ledger().set_timestamp(f.cancel_deadline + 1);
    assert_eq!(f.claim_no_show(), Ok(Ok(())));

    let token = f.token_client();
    assert_eq!(token.balance(&f.professional), f.amount);
    assert_eq!(
        token.balance(&f.contract_id),
        second_amount,
        "the other booking's deposit left the escrow"
    );

    // And the second booking is not yet claimable: its own window is still open.
    assert_eq!(
        f.client_contract.try_claim_no_show(&second_id),
        Err(Ok(Error::TooEarly))
    );
    f.env.as_contract(&f.contract_id, || {
        assert_eq!(
            storage::get_booking(&f.env, &second_id).unwrap().state,
            BookingState::Locked
        );
    });
}
