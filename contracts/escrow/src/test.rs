use soroban_sdk::Env;

use crate::EscrowContract;

#[test]
fn contract_registers_in_test_env() {
    let env = Env::default();
    let contract_id = env.register(EscrowContract, ());

    // A registered contract gets a distinct address.
    let other_id = env.register(EscrowContract, ());
    assert_ne!(contract_id, other_id);
}
