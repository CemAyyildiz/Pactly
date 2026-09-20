# Pactly — Project Summary (Rise In × Stellar Pro Hackathon 2026, Genesis Track)

**Pactly** — the deposit that protects both sides of an appointment.

Live: <https://pactly-phi.vercel.app> · Code: <https://github.com/CemAyyildiz/Pactly> · Stellar testnet

A 14:00 hair-transplant consultation in Istanbul is a real hour. If the client from abroad doesn't show, the clinic loses the slot. If the clinic asks for a deposit up front, the client wires serious money to a shop they've never walked into — cards fail across borders, a bank transfer can't hold money in the middle, and a "cancellation policy" never actually collects. Today one side always eats it, so cross-border appointments either don't get booked or get booked on trust that breaks.

Pactly puts the deposit where neither side can touch it. Pick a slot, pay the deposit in lira by bank transfer (SEP-6 through the anchor, with its auth, KYC and quote steps), and Trustless Work deploys a Soroban escrow on Stellar for that exact booking: the shop is the receiver, the client approves, Pactly only steps in if they disagree. The money moves when the appointment is completed and approved — or comes back on a timely cancellation. Every booking links its contract on Stellar Expert, so the proof isn't ours to fake.

The client never sees crypto: sign-in is a passkey (Face ID) on a Stellar Passkey Kit smart wallet — no wallet app, no seed phrase, prices in lira. Built and deployed: discovery, profiles, the TRY deposit rail, the full booking lifecycle with disputes, and provider onboarding with admin approval.
