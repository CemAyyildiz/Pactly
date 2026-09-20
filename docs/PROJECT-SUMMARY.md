# Pactly — Project Summary (Rise In × Stellar Pro Hackathon 2026, Genesis Track)

**Live app:** https://pactly-phi.vercel.app  
**Repository:** https://github.com/CemAyyildiz/Pactly  
**Network:** Stellar testnet · **Escrow:** Trustless Work Core v2 · **Signer:** Stellar Passkey Kit · **Local currency:** TRY via SEP-6 (`tr-mock-anchor.fly.dev`)

## One paragraph

Pactly is a booking marketplace for appointment-based services — clinics, barbers, therapists, tutors — where the client's deposit sits in an escrow that neither the client nor the shop controls. A client abroad can book a 14:00 hair-transplant consultation in Istanbul and lock a meaningful deposit without wiring money to a stranger: Trustless Work deploys a single-release Soroban escrow for that exact booking, the shop is the receiver, the client is funder and approver, and Pactly is only the resolver if the two sides disagree. The deposit releases when the appointment is marked complete and the client approves, or returns to the client on a timely cancellation. Every booking links its contract on Stellar Expert and Trustless Work's Escrow Viewer, so the proof is on chain, not in a screenshot.

## What makes it different

- **No wallet, no crypto on screen.** Sign-in is a passkey (Face ID / fingerprint) that becomes the signer of a Stellar Passkey Kit smart wallet; the backend fee-sponsors so the user never holds XLM. Every amount is shown in Turkish lira and the deposit is paid by a TRY bank transfer through the anchor (SEP-1/10/12/6/38). The USDC in escrow is an implementation detail.
- **The chain is the source of truth for money.** A booking's `escrow_state` is written only after the reconciler reads the Trustless Work contract; the marketplace database never invents money state. The backend only builds unsigned transactions — it holds no key that could move a client's or a provider's funds.
- **A real marketplace, not a demo screen.** Discover with search and filters, provider profiles with open slots, a two-sided booking status panel, complete → approve → release, dispute → resolution, balance payment (through Pactly or marked paid in person), "List your shop" provider applications with an admin approval queue.

## Stellar integrations

| Integration | Role in Pactly |
|---|---|
| Trustless Work Core v2 (Soroban single-release escrow) | The deposit: one contract per booking, deployed at lock, explicit role map (client = funder/approver, provider = receiver/release signer, Pactly = platform/dispute resolver) |
| Stellar Passkey Kit (WebAuthn smart wallet) | Identity and every escrow signature; canonical wallet WASM `97ce0478…764e` |
| Anchor `tr-mock-anchor.fly.dev` — SEP-1, SEP-10, SEP-12, SEP-6, SEP-38 | TRY pay-in that lands as USDC in the user's wallet, plus the live TRY/USDC rate every screen converts with |
| Circle testnet USDC (SAC `CBIELTK6…DAMA`) | Escrow token |
| Soroban RPC | Fee-sponsored passkey submissions and the independent balance payment |

## Status

Discovery, profiles, holds, the TRY deposit flow, the booking lifecycle screens, provider onboarding and the admin queues are built, tested (490+ backend tests) and deployed. The one open item is the first signed lock against a live Trustless Work operator key: the adapter and reconciler are built and verified against the correct API host (`beta.api.trustlesswork.com`), and the remaining step is an accepted operator key on that host.

## Team and process

Built solo with the BMAD Method skill set (PRD → UX → architecture → sprint → build → review), the Stellar skills for Passkey Kit, anchors and Trustless Work, and an "Editorial Warmth" design language (warm paper, serif mastheads, Phosphor icons) chosen so a first-time user sees a booking site, not a crypto app.

## After the hackathon

Provider cash-out in TRY (SEP-6 withdraw), then optional, off-by-default yield on locked deposits (XOXNO Lending) for long-window bookings.
