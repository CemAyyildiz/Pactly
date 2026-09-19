---
title: 'Story 1.1 — Monorepo skeleton and development environment'
type: 'chore'
created: '2026-09-17'
status: 'ready-for-dev'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Pactly-2026-09-16/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repository holds planning documents and no code. Every later story needs a place to put files, a pinned toolchain, and a single command that installs and runs the project; without that, each story would invent its own layout.

**Approach:** Create the four-directory monorepo the architecture spine fixes (`contracts/escrow`, `backend`, `frontend`, `scripts`), wire it as an npm workspace with pinned versions, add a Soroban crate that compiles and tests empty, and document install/build/run in the README.

## Boundaries & Constraints

**Always:**
- Follow the directory layout and pinned versions in the architecture spine; do not invent a different structure.
- Everything is English: identifiers, comments, docs, commit messages.
- The escrow crate builds for `wasm32v1-none` and avoids deprecated Soroban APIs (`register_contract`).
- Secrets stay out of the repository; `.env` is ignored and `.env.example` documents the keys.
- Backend reads configuration in one place (`backend/src/config.ts`) and refuses to start when a variable is missing.

**Never:**
- No business logic: no booking struct, no contract functions, no API endpoints, no screens beyond a placeholder. Those belong to Stories 1.2+ and Epic 3.
- Do not install the Stellar CLI or touch the machine's global toolchain; document the requirement instead.
- Do not deploy anything or call the network.
- Do not create database schema or migrations (Story 2.5 owns those).

</frozen-after-approval>

## Code Map

The repository has no source code yet; everything here is new. Existing files that constrain the work:

- `_bmad-output/planning-artifacts/architecture/architecture-Pactly-2026-09-16/ARCHITECTURE-SPINE.md` -- authority for the directory layout ("Structural Seed"), pinned versions ("Stack") and naming conventions. Reuse verbatim; do not re-decide.
- `_bmad-output/implementation-artifacts/epic-1-context.md` -- epic constraints for the contract work that follows.
- `README.md` -- already carries the product story, architecture diagram and a "Setup (planned)" section promising `npm install`, `npm run setup:testnet` and `npm run dev`. Make those commands real or correct the section; do not duplicate it.
- `.gitignore` -- exists with `node_modules/`, `.env`, `target/`, `dist/`. Extend rather than replace.
- Verified locally: Node v22.17.0, npm 11.6.0, rustc/cargo 1.97.1, `wasm32v1-none` target installed, **Stellar CLI absent**.

## Tasks & Acceptance

**Execution:**
- [ ] `package.json` -- create the root workspace (`backend`, `frontend`), `"private": true`, engines `node >=22`, and scripts: `dev` (backend + frontend together), `build`, `test`, `contracts:build`, `contracts:test` -- one entry point for every later story.
- [ ] `contracts/escrow/Cargo.toml`, `contracts/escrow/src/lib.rs` -- crate `pactly-escrow`, `crate-type = ["cdylib", "rlib"]`, soroban-sdk 27.0.6, release profile tuned for wasm size; `lib.rs` holds an empty `#[contract]` struct and no logic -- Story 1.2 fills the data model.
- [ ] `contracts/escrow/src/test.rs` -- one smoke test asserting the contract registers in a test env, so `cargo test` is green from day one.
- [ ] `rust-toolchain.toml` -- pin the Rust channel and the `wasm32v1-none` target so every machine builds the same artifact.
- [ ] `backend/package.json`, `backend/tsconfig.json`, `backend/src/index.ts`, `backend/src/config.ts` -- Hono server with a `/health` route; `config.ts` reads and validates env vars once and throws on a missing one.
- [ ] `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx` -- Vite + React + TypeScript scaffold with a placeholder screen; no design system yet.
- [ ] `scripts/README.md` -- state what lands here (funding, trustlines, deploy, seed) and that Story 1.7 implements it.
- [ ] `.env.example` -- document the variables the architecture names: network passphrase, RPC URL, anchor home domain, contract id, admin wallets, database path.
- [ ] `.gitignore` -- extend for the Rust and Node artifacts the new layout produces.
- [ ] `README.md` -- replace "Setup (planned)" with verified commands and the real prerequisites, including the Stellar CLI note.

**Acceptance Criteria:**
- Given a clean checkout, when `npm install` runs from the root, then both workspaces install with no errors.
- Given the repository, when `npm run dev` runs, then the backend serves `/health` and the frontend dev server serves the placeholder screen, both from one command.
- Given the contract crate, when `npm run contracts:test` (or `cargo test` inside `contracts/escrow`) runs, then the smoke test passes.
- Given the contract crate, when it is built for `wasm32v1-none`, then a `.wasm` artifact is produced without deprecated-API warnings.
- Given a missing required variable, when the backend starts, then it exits with a message naming the variable rather than starting half-configured.
- Given the README, when a new developer follows it top to bottom, then they reach a running app without needing any step that is not written down.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

Decisions taken during planning, so implementation does not re-open them:

- **The escrow crate ships empty but compiling.** A crate that builds and tests green from Story 1.1 means 1.2 starts from a working baseline instead of a scaffold plus a first failure.
- **npm workspaces, not a monorepo tool.** Two workspaces do not justify Nx or Turborepo; the root `package.json` is the single entry point.
- **The Stellar CLI is documented, not installed.** It is first needed in Story 1.7 (deploy). Installing it would touch the developer's machine, which this story has no mandate to do.
- **The Rust crate stays outside the npm workspace.** Cargo owns it; npm scripts only shell out to `cargo`.

## Verification

**Commands:**
- `npm install` -- expected: both workspaces resolve, no peer-dependency errors
- `npm run dev` -- expected: backend and frontend both start; `curl localhost:<port>/health` returns ok
- `npm run contracts:test` -- expected: `cargo test` passes with the smoke test
- `cargo build --target wasm32v1-none --release` (in `contracts/escrow`) -- expected: a `.wasm` artifact, no deprecation warnings
- start the backend with a required variable unset -- expected: the process exits and names the missing variable
