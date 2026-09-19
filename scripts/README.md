# scripts

Testnet tooling for Pactly. Nothing lives here yet; **Story 1.7 (Testnet setup scripts)** implements it.

What lands here:

- **Funding** — create and fund test accounts on Stellar testnet (Friendbot).
- **Trustlines** — add the USDC trustline the anchor (`tr-mock-anchor.fly.dev`) issues to those accounts.
- **Deploy** — build and deploy the escrow contract from `contracts/escrow/` with the Stellar CLI.
- **Seed** — create sample categories and providers for the demo.

Script output is shaped so it can be written straight into the repository-root `.env` (keys documented in `.env.example`). Secrets are never committed.

These scripts will need the [Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli); the rest of the repository does not.
