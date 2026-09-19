#![no_std]

//! Pactly escrow contract.
//!
//! Story 1.1 ships this crate empty but compiling. The booking data model,
//! `initialize`, `create_booking`, `release` and `resolve_cancel` arrive in
//! Stories 1.2 to 1.5.

use soroban_sdk::contract;

#[contract]
pub struct EscrowContract;

#[cfg(test)]
mod test;
