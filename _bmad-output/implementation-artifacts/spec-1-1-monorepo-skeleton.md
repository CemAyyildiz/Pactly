---
title: 'Story 1.1 — Monorepo skeleton and development environment'
type: 'chore'
created: '2026-09-17'
status: 'done'
baseline_commit: 'a37dc038a3787ee7b46935a3067cf9c513d3bd13'
route: 'dispatch'
review_loop_iteration: 1
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
- [x] `package.json` -- create the root workspace (`backend`, `frontend`), `"private": true`, engines `node >=22`, and scripts: `dev` (backend + frontend together), `build`, `test`, `contracts:build`, `contracts:test` -- one entry point for every later story.
- [x] `contracts/escrow/Cargo.toml`, `contracts/escrow/src/lib.rs` -- crate `pactly-escrow`, `crate-type = ["cdylib", "rlib"]`, soroban-sdk 27.0.6, release profile tuned for wasm size; `lib.rs` holds an empty `#[contract]` struct and no logic -- Story 1.2 fills the data model.
- [x] `contracts/escrow/src/test.rs` -- one smoke test asserting the contract registers in a test env, so `cargo test` is green from day one.
- [x] `rust-toolchain.toml` -- pin the exact Rust version (`channel = "1.97.1"`) and the `wasm32v1-none` target so every machine builds the same artifact.
- [x] `backend/package.json`, `backend/tsconfig.json`, `backend/src/index.ts`, `backend/src/config.ts` -- Hono server with a `/health` route; `config.ts` reads and validates env vars once and throws on a missing one.
- [x] `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx` -- Vite + React + TypeScript scaffold with a placeholder screen; no design system yet.
- [x] `scripts/README.md` -- state what lands here (funding, trustlines, deploy, seed) and that Story 1.7 implements it.
- [x] `.env.example` -- document the variables the architecture names: network passphrase, RPC URL, anchor home domain, contract id, admin wallets, database path.
- [x] `.gitignore` -- extend for the Rust and Node artifacts the new layout produces.
- [x] `README.md` -- replace "Setup (planned)" with verified commands and the real prerequisites, including the Stellar CLI note.

**Acceptance Criteria:**
- Given a clean checkout, when `npm install` runs from the root, then both workspaces install with no errors.
- Given the repository, when `npm run dev` runs, then the backend serves `/health` and the frontend dev server serves the placeholder screen, both from one command.
- Given the contract crate, when `npm run contracts:test` (or `cargo test` inside `contracts/escrow`) runs, then the smoke test passes.
- Given the contract crate, when it is built for `wasm32v1-none`, then a `.wasm` artifact is produced without deprecated-API warnings.
- Given a missing required variable, when the backend starts, then it exits with a message naming the variable rather than starting half-configured.
- Given the README, when a new developer follows it top to bottom, then they reach a running app without needing any step that is not written down.

## Implementation Notes

- Review patches applied in place (triage #2, #4, #5): backend `test` script with child-process config tests (`PACTLY_ENV_FILE` isolates them from a real `.env`), `tsx watch --include ../.env`, `DATABASE_PATH` resolved against `backend/`.
- The first `package-lock.json` omitted every `@esbuild/*` platform package, so `tsx` failed under `npm run dev` on a cold transform cache. Regenerated from a fresh `node_modules`; the lockfile now records them.

## Spec Change Log

- **Loop 1 (2026-09-17)** — Trigger: triage #1 (BH1/EC10), `rust-toolchain.toml` used floating `channel = "stable"`. Human decision: pin `channel = "1.97.1"`; rustup auto-installing that pinned toolchain under `~/.rustup` is accepted and does not count as touching the machine's global toolchain. Amended: the `rust-toolchain.toml` task and a Design Note. Known-bad state avoided: a floating channel that lets different machines build different wasm. KEEP: human chose to keep the existing implementation and fix in place instead of reverting; everything else in the diff (workspace layout, pinned npm versions, `declared()` for empty-but-present `ESCROW_CONTRACT_ID`/`PACTLY_ADMIN_WALLETS`, README setup) stays.

## Review Triage Log

Review loop 1 (blind-hunter BH, edge-case-hunter EC, verification-gap VG).

| # | Location | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|---|
| 1 | `rust-toolchain.toml:3` | BH1 / EC10: `channel = "stable"` floats; task says pin so every machine builds the same artifact | medium | Confirmed: only `stable` and `1.88` toolchains installed; `channel = "1.97.1"` would make rustup download a toolchain, which the frozen "do not touch the machine's global toolchain" boundary may forbid. Two readings; the intent does not settle which wins. | intent_gap |
| 2 | `backend/src/config.ts` | VG1 / BH4: config fail-fast rules have no automated test; `npm test` never runs backend code | medium | Pre-verified by VG layer: no backend test script or test file; `--if-present` skips workspaces. | patch |
| 3 | `backend/src/index.ts:8` | VG2: `/health` has no automated check | low | Pre-verified by VG layer; filed disposition defer (placeholder route). | defer |
| 4 | `backend/package.json` dev script | EC2: editing root `.env` does not restart `tsx watch` | low | `tsx watch` only watches the import graph; `.env` is read via `process.loadEnvFile`, not imported. `--include` exists in tsx 4.23. Direct one-flag fix. | patch |
| 5 | `backend/src/config.ts` / `.env.example` | BH6 / EC7: relative `DATABASE_PATH` resolves against cwd, not a fixed base | low | Starting from repo root (`node backend/dist/index.js`) resolves `./data` at root. Direct fix: resolve against the backend directory. | patch |
| 6 | `package.json` dev / `tsx watch` | BH7 / EC1 / EC11: after config failure under `npm run dev` the watcher stays alive and the frontend keeps running | low | Real (verified by implementer and EC). The message naming the variable is still printed, and waiting for a fix is normal watch behaviour once #4 lands. Fix needs extra preflight machinery. | reject |
| 7 | `backend/src/config.ts` | BH2: empty `ESCROW_CONTRACT_ID` / `PACTLY_ADMIN_WALLETS` accepted; deviation unrecorded | false | Present-but-empty is the only reading that also satisfies the README AC (contract id does not exist until Story 1.7); a missing key still exits. Recording it would edit this spec. | reject |
| 8 | spec / `sprint-status.yaml` | BH3: status mismatch, `in-review` not a sprint value | false | `in-review` is a valid spec-template status; sprint sync to `review` happens at presentation. | reject |
| 9 | `backend/src/config.ts` | BH5 / EC6: no format validation for URL, `C...`/`G...` ids | low | Nothing consumes these values in this story; adds guards. | reject |
| 10 | root dev setup | BH8: no Vite proxy / CORS | false | No frontend→backend call exists in this change; no bad outcome occurs. | reject |
| 11 | `package.json` engines | BH9 / EC9 / EC12: engines not enforced; `>=22.12.0` vs spec `>=22` | false | Vite 8 itself requires Node ≥22.12, so the stricter range is correct; local Node 22.17; engine-strict adds a file for an unlikely case. | reject |
| 12 | `contracts/escrow/src/test.rs` | BH10: smoke test registers twice, comment oversells | false | Test satisfies "asserting the contract registers in a test env"; no named harm. | reject |
| 13 | `contracts/escrow/test_snapshots/` | BH11: snapshot committed, no trailing newline | false | SDK-generated file; committing snapshots is the Soroban convention. | reject |
| 14 | `package.json` contracts:build | BH12: no automated check for deprecation warnings | low | Manual build re-run shows no warnings; adding `-D warnings` is extra machinery. | reject |
| 15 | `README.md` | BH13: hard-coded port 3001, no Rust minimum | false | 3001 is the documented `.env.example` default; `rust-toolchain.toml` selects the toolchain. | reject |
| 16 | `backend/src/index.ts` | BH14 / EC5: `EADDRINUSE` raw stack, no signal handling, plain console logs vs spine JSON logging | low | Real, but the stack names `EADDRINUSE`; logging infrastructure is not in this story's tasks; fix adds handlers. | reject |
| 17 | `.gitignore` | BH15: redundant `*.wasm` / db entries | low | Cosmetic; root `./data` case is removed by #5. | reject |
| 18 | `frontend/tsconfig.json` | BH16: `vite.config.ts` type-checked with DOM libs | low | Builds today; harm only if config later uses Node APIs; fix adds a tsconfig file. | reject |
| 19 | `backend/src/config.ts:230` | EC3: unreadable/directory `.env` gives raw stack | low | Unlikely; adds try/catch guard. | reject |
| 20 | `backend/src/config.ts:264` | EC4: `BACKEND_PORT=0x10` / `1e3` coerced | low | `Number("0x10") === 16` confirmed; unlikely input; adds guard. | reject |
| 21 | `backend/src/config.ts:305` | EC8 / VG other: import-time `process.exit` hampers in-process tests | low | Tests can set env or spawn a child process (#2 does); fix restructures module. | reject |

## Design Notes

Decisions taken during planning, so implementation does not re-open them:

- **The escrow crate ships empty but compiling.** A crate that builds and tests green from Story 1.1 means 1.2 starts from a working baseline instead of a scaffold plus a first failure.
- **npm workspaces, not a monorepo tool.** Two workspaces do not justify Nx or Turborepo; the root `package.json` is the single entry point.
- **The Stellar CLI is documented, not installed.** It is first needed in Story 1.7 (deploy). Installing it would touch the developer's machine, which this story has no mandate to do.
- **Rust is pinned to an exact version.** `rust-toolchain.toml` names `1.97.1`; rustup installing that toolchain on first `cargo` run is expected and allowed.
- **The Rust crate stays outside the npm workspace.** Cargo owns it; npm scripts only shell out to `cargo`.

## Verification

**Commands:**
- `npm install` -- expected: both workspaces resolve, no peer-dependency errors
- `npm run dev` -- expected: backend and frontend both start; `curl localhost:<port>/health` returns ok
- `npm run contracts:test` -- expected: `cargo test` passes with the smoke test
- `cargo build --target wasm32v1-none --release` (in `contracts/escrow`) -- expected: a `.wasm` artifact, no deprecation warnings
- start the backend with a required variable unset -- expected: the process exits and names the missing variable
