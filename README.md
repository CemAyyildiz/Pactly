# Pactly

A trust-backed booking marketplace for appointment-based services. The deposit is locked in a Stellar contract neither side controls: it goes to the provider when the session happens, and back to the client when they cancel in time.

**Event:** Rise In × Stellar Pro Hackathon 2026 — Genesis Track
**Network:** Stellar testnet · **Asset:** USDC · **Anchor:** `tr-mock-anchor.fly.dev`

> Status: implementation in progress. The setup steps below are verified against the current code.

## The problem

In every appointment-based profession, the product is time. When a client does not show up, that hour cannot be resold. If the provider asks for prepayment, the risk simply moves to the client: sending money up front to someone you have never met, often in another country, takes trust.

Pactly holds the deposit somewhere neither side can reach. The contract enforces the rule, not the parties.

## How it works

1. A client finds a provider on the marketplace and picks a slot.
2. They pay the deposit from their wallet (USDC) or in local currency; the amount locks in a Soroban contract.
3. If the session happens, the client confirms and the deposit is released to the provider.
4. Cancel in time and the deposit is refunded; cancel late or no-show and it transfers to the provider.
5. The provider cashes out in local currency through SEP-6. They never need to know anything about crypto.

## Architecture

Paradigm: **chain-authoritative layered services**. The contract is the sole authority on money state; the backend mirrors it; the frontend presents and signs.

```mermaid
graph TD
  subgraph client["Browser"]
    FE["frontend · React + Vite<br/>screens, wallet signing"]
  end
  subgraph server["Server"]
    BE["backend · Node + Hono<br/>bookings, marketplace, SEP flows"]
    EW["event worker<br/>cursored event ingestion"]
    DB[("SQLite · Drizzle<br/>providers, bookings, categories, reviews")]
  end
  subgraph chain["Stellar testnet"]
    CT["escrow contract · Soroban<br/>create_booking · release · cancel · claim_no_show"]
    AN["anchor · SEP-1/10/6/12/38<br/>fiat ↔ USDC"]
  end

  FE -->|"REST + Pactly JWT"| BE
  FE -->|"signed transaction"| CT
  BE --> DB
  BE -->|"reads + call wrapper"| CT
  BE -->|"deposit · withdraw · quotes"| AN
  EW -->|"locked / released / refunded"| CT
  EW --> DB
```

**Load-bearing rules**

| Rule | What it buys |
|---|---|
| Money state is written only from a chain event | The backend and the contract cannot silently diverge |
| Every deposit path is signed by the party it serves | Pactly cannot move money on a user's behalf, a stranger cannot close a booking, a provider is never paid for cancelling, and a no-show never strands the provider |
| A booking carries two states: deposit and balance | Two different payments never overwrite each other |
| Marketplace data lives only in the database, deposits only on chain | One record of truth per fact |
| The "verified sessions" count only increases on a `released` event | The quality signal cannot be fabricated |

Full set with rationale: [`ARCHITECTURE-SPINE.md`](_bmad-output/planning-artifacts/architecture/architecture-Pactly-2026-09-16/ARCHITECTURE-SPINE.md)

## Repository layout

```text
contracts/escrow/   # Soroban escrow contract (Rust)
backend/            # Node.js + TypeScript: marketplace, SEP integrations, event worker
frontend/           # React + TypeScript + Vite
scripts/            # testnet funding, trustlines, deployment, seed data
```

## Setup

### Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 22 LTS (>= 22.12) | backend and frontend |
| npm | 10 or newer | workspaces |
| Rust (rustup) | 1.97.1, pinned in `rust-toolchain.toml` (rustup installs it on first cargo run) | escrow contract |
| `wasm32v1-none` target | `rustup target add wasm32v1-none` | contract wasm build |
| Stellar CLI | current release — [install guide](https://developers.stellar.org/docs/tools/cli/install-cli) | testnet deployment only (Story 1.7); not needed to run the app or the contract tests |

### Install and run

```bash
npm install                 # installs both workspaces (backend, frontend)
cp .env.example .env        # the defaults point at Stellar testnet and run as-is
npm run dev                 # backend + frontend together
```

- Backend: <http://localhost:3001/health> returns `{"status":"ok"}`.
- Frontend: <http://localhost:5173> shows the placeholder screen.

The backend reads every variable once in `backend/src/config.ts` and exits, naming the variable, if one is missing from `.env`.

### Other commands

```bash
npm run build               # type-check and build backend and frontend
npm test                    # contract tests, then any workspace tests
npm run contracts:test      # cargo test in contracts/escrow
npm run contracts:build     # release wasm → contracts/escrow/target/wasm32v1-none/release/pactly_escrow.wasm
```

`npm run setup:testnet` (test accounts, trustlines, contract deploy → `.env`) arrives with Story 1.7; see [`scripts/README.md`](scripts/README.md).

## Stack

| Layer | Choice |
|---|---|
| Contract | Rust · soroban-sdk 27.0.6 |
| Backend | Node.js 22 · TypeScript · Hono 4 · Drizzle ORM · SQLite |
| Frontend | React 19 · Vite 8 · TanStack Query 5 · Motion 13 |
| Stellar | @stellar/stellar-sdk 17 · Stellar Wallets Kit 2.6 |

## Planning documents

| Document | Contents |
|---|---|
| [`prd.md`](_bmad-output/planning-artifacts/prd.md) | Product requirements (v1.2), epics and stories |
| [`ARCHITECTURE-SPINE.md`](_bmad-output/planning-artifacts/architecture/architecture-Pactly-2026-09-16/ARCHITECTURE-SPINE.md) | Architecture decisions (AD-1…AD-14), consistency conventions |
| [`DESIGN.md`](_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md) | Visual system: colour rule, typography, components |
| [`EXPERIENCE.md`](_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md) | Information architecture, states, copy rules, flows |

## Skill files used

As required by the hackathon, planning was run with BMAD Method skills:

| Skill | Path |
|---|---|
| bmad-ux | `.claude/skills/bmad-ux/SKILL.md` |
| bmad-prd | `.claude/skills/bmad-prd/SKILL.md` |
| bmad-architecture | `.claude/skills/bmad-architecture/SKILL.md` |
| bmad-sprint-planning | `.claude/skills/bmad-sprint-planning/SKILL.md` |
| ui-ux-pro-max | `.claude/skills/ui-ux-pro-max/SKILL.md` |
