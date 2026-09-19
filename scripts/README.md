# scripts

Testnet tooling for Pactly. One command gets a demo from nothing to a funded,
deployable state:

```bash
npm run --silent setup:testnet
```

It funds three Stellar testnet accounts (`admin`, `professional`, `client`)
through Friendbot, adds each of `professional` and `client`'s testnet USDC
trustline with the anchor discovered from `ANCHOR_HOME_DOMAIN`'s
`stellar.toml` (AD-10 — the issuer and asset code are never hard-coded), and
builds and deploys the escrow contract from `contracts/escrow/` with the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli). The
CLI is required for the deploy step; nothing else in the repository needs it.

## Before you run it

Copy `.env.example` to `.env` at the repository root if you have not already,
and make sure `ANCHOR_HOME_DOMAIN`, `STELLAR_NETWORK_PASSPHRASE` and
`SOROBAN_RPC_URL` are set (`.env.example`'s defaults are already testnet
values).

## What it prints

Progress ("already funded, skipping", "trustline added", ...) goes to
stderr. The result — `PACTLY_DEMO_ADMIN_SECRET`, `PACTLY_DEMO_PROFESSIONAL_SECRET`,
`PACTLY_DEMO_CLIENT_SECRET`, `PACTLY_ADMIN_WALLETS` and `ESCROW_CONTRACT_ID` —
prints to stdout as `.env` lines. Run it with `npm run --silent` (so npm's own
banner lines don't end up mixed into that output) and paste the printed lines
into `.env`, replacing whatever is already there for those keys:

```bash
npm run --silent setup:testnet
```

Redirecting straight into `.env` only makes sense the very first time, before
the file has any of these keys yet — on every later run, appending (`>>`)
would duplicate each key instead of replacing it, since this command never
reads or edits `.env` itself.

Secret keys only ever go to stdout for you to place in `.env`. `.env` is
gitignored and this command never writes it itself, so it never overwrites a
key you already placed there — re-run it any time and it fills in whatever is
still missing. If a run stops partway (a failed step, a missing tool), it
still prints whatever it had already resolved — including newly generated,
already-funded account secrets — so nothing is left orphaned on chain with no
way to reuse it.

## Re-running it

Every step checks whether it is already done before acting: an account that
Friendbot already funded, a trustline that already exists, and a contract id
already in `.env` (or the shell environment) are each recognised and skipped,
so a second run reports the same result instead of failing. A demo account's
secret key already in `.env` is reused rather than regenerated.

## What it does not do (yet)

Seeding sample categories and providers for the demo is not part of this
command. The contract's `initialize` (admin address) is also a separate,
deliberate step — this command only deploys the wasm and hands you the
contract id.

## Layout

- `src/toml.ts`, `src/decisions.ts`, `src/demo-accounts.ts`, `src/env-lines.ts`
  — the pure logic: parsing `stellar.toml`, deciding what is already done, and
  shaping the printed output. Unit-tested with Node's built-in test runner
  (`npm run -w scripts test`) — no network involved.
- `src/anchor.ts`, `src/horizon.ts`, `src/cli.ts` — thin network/process
  wrappers around that logic (fetching `stellar.toml`, talking to Horizon,
  shelling out to `cargo` and `stellar`).
- `src/setup-testnet.ts` — the command itself, run through `tsx`.
