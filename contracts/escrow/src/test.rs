#![cfg(test)]

use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, BytesN as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, InvokeError,
};

use crate::storage::{self, DataKey, BUMP_LEDGERS};
use crate::types::{Booking, BookingState};
use crate::{EscrowContract, EscrowContractClient, Error};

fn setup() -> (Env, Address, EscrowContractClient<'static>) {
    let env = Env::default();
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    (env, contract_id, client)
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
}
