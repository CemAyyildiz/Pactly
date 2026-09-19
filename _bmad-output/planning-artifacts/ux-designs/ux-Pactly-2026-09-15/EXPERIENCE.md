---
name: Pactly
description: A trust-backed booking marketplace for appointment-based services — experience spine
status: final
updated: 2026-09-17
sources:
  - "../../prd.md"
  - "./DESIGN.md"
---

# Pactly — Experience Spine

> The visual identity lives in `DESIGN.md`; tokens are referenced as `{colors.you}`. Where a mockup disagrees with these two documents, the documents win.

## Foundation

One surface: a **responsive web app** (React + TypeScript + Vite, PRD §3). A native mobile app is out of scope and stays a vision item.

No component library is adopted; components are built from `DESIGN.md`. Motion uses Framer Motion.

There are two user roles and one operator role:

- **Client** — the side buying the service. Mobile-first; the flow must be completable one-handed.
- **Provider** — the side delivering the service, admitted through curation. Desktop-first; the panel carries dense data.
- **Admin** — the Pactly operator approving applications. A plain list screen is enough.

Authentication is a wallet signature (SEP-10). **The wallet is requested only at payment.** Discovery, search, profile viewing and price comparison need no sign-in.

The product is vertical-agnostic: copy is never written for a single profession. The interface says "session" and addresses the reader as "you". Therapy is only the demo scenario.

The product is built for a global audience: all copy is English, amounts carry their currency code, and no screen assumes a single country. The demo runs on the TRY rail the hackathon anchor provides, but no component hard-codes it.

## Information Architecture

| Surface | Reached from | Purpose | Priority |
|---|---|---|---|
| Discover | Home, logo | Find providers by category, search and filters | MVP |
| Search results | Search box | Providers filtered by query | MVP |
| Provider profile | Result card, shared link | Learn about a provider, pick a slot, see the deposit | MVP |
| Booking & payment | Slot selection | Form the promise: slot, deposit, payment method, lock | MVP |
| Locked confirmation | After payment | Seal the promise, show the proof and the next steps | MVP |
| My bookings (client) | Top nav | Bookings across all providers, deposit states, cancel and confirm | MVP |
| Provider panel | Top nav (provider role) | Incoming bookings, deposit states, earnings | MVP |
| Availability & rules | Provider panel | Working hours, price, deposit rate, cancellation window | MVP |
| Cash out | Provider panel | Withdraw released deposits in local currency via SEP-6 | MVP |
| Become a provider | Top nav | Application form and application status | MVP |
| Admin approval queue | Direct link | Approve or reject applications | MVP (plain) |
| Write a review | Completed booking | Only after a released deposit | Post-MVP |
| Edit provider profile | Provider panel | Bio, photo, languages | Post-MVP |

A client can hold bookings with several providers at once; "My bookings" shows them in one list, ordered by date.

→ Composition reference: `mockups/discover.html`, `mockups/booking-and-payment.html`. This spine wins on conflict.

## Voice and Tone

Copy is short, direct and in the second person. Implementation vocabulary is never shown; technical identifiers (transaction, contract) are shown, because they are the proof.

| Do | Don't |
|---|---|
| "Your deposit is in escrow." | "Your payment has been successfully transferred to escrow." |
| "Cancel before Sep 17, 2:00 PM and you get all of it back." | "Cancellation policy: 24 hours." |
| "Cancel after this and the deposit goes to Dr. Aydın." | "No refunds on late cancellations." |
| "You're set." | "Transaction successful! 🎉" |
| "Approve it in your wallet." | "Please confirm the signature request." |
| "No providers open at that hour. Try:" | "No results found." |
| "Connection dropped. Your deposit is untouched." | "An error occurred." |

**Crypto words:** "Stellar", "USDC", "wallet", "transaction" and "contract" are used, because trust rests on them. "Smart contract", "Soroban", "trustline", "SEP-6", "ledger" and "hash" are never shown to the user. Say: escrow, contract, deposit account, transaction record.

**Every sentence about the deposit carries two facts:** the amount and the free-cancellation window.

**Currency:** amounts always appear with their code (`600.00 TRY`, `14.35 USDC`). No screen writes a currency symbol into a string.

## Component Patterns

Visual specs live in `DESIGN.md.Components`.

| Component | Used on | Behaviour |
|---|---|---|
| Search box | Discover, top nav | Autocomplete after a 250 ms debounce. Suggestions cover services, categories and provider names, each with its result count. Enter is never required. |
| Category tabs | Discover | Single select. The selection is written to the URL; the back button works. |
| Filter rail | Discover (≥1024px) | Every change updates results without a reload. On mobile the active filter count shows on the button. |
| Provider card | Discover, search | The whole card is clickable. Tapping a slot chip opens the profile with that slot selected. |
| Slot chip | Card, profile, booking | A taken slot is not clickable and takes no focus. Selection changes on a single tap, with no confirmation. |
| Deposit pill | Card, profile, booking, my bookings | Informational, never clickable. Amount and free-cancellation window together. |
| Balance row | Booking, booking detail | "Balance 1,400.00 TRY · due before the session" — payment state is one of three: unpaid, paid through Pactly, paid in person. The provider can mark a cash payment. |
| Escrow lane | Booking | Stays visible through the page. On mobile it pins to the bottom carrying the deposit amount. |
| Lock button | Booking | One tap asks for the wallet signature. After it is pressed the button disables and moves to "Approve it in your wallet". |
| Countdown | My bookings, locked confirmation | Time left in the free-cancellation window. Turns `{colors.alert}` under 6 hours. |
| Proof row | Locked confirmation, booking detail | The shortened transaction id and an explorer link. Opens in a new tab. |
| State label | My bookings, provider panel | Four states: Locked · Released · Refunded · Transferred. Text always accompanies the colour. |

## State Patterns

| State | Surface | Treatment |
|---|---|---|
| First load | Discover | Six card skeletons matching the real layout. |
| No results | Search | A blank screen is forbidden. Echo the query, then three concrete suggestions: loosen a filter, try another time, browse the whole category. |
| Empty list | My bookings | "No bookings yet." plus a primary action into Discover. |
| Waiting on wallet | Booking | Button disabled, copy reads "Approve it in your wallet". After 60 seconds an "Open wallet again" option appears. |
| Wallet rejected | Booking | Information, not a warning: "You didn't sign. The slot is still yours for 10 minutes." |
| Missing trustline | Booking | The user never sees the term. The flow prepares the account automatically under the copy "Getting your wallet ready". If an extra approval is needed it is asked for in one sentence. |
| Waiting on a local-currency payment | Booking | Bank details and a reference are shown and can be copied. The state updates by itself; the user never has to refresh. |
| Waiting on chain confirmation | Locking | The seal is not stamped yet. A "Locking" state and the transaction id are shown; the seal animates once the event confirms. |
| Amount outside limits | Booking | If the deposit is below 50 TRY or above 3,000 TRY the user is warned **before** the payment step and offered the other payment method. |
| Slot taken | Booking | If the chosen slot was locked by someone else: "That slot just went." plus the other slots that day. |
| Connection dropped | Any surface | "Connection dropped. Your deposit is untouched." with a retry action. |
| Window closed | My bookings | When the free-cancellation window passes, the card takes an `{colors.alert}` border and the consequence of cancelling is written into the copy. |
| Pending approval (provider) | Provider panel | Until the application is approved the panel is read-only, with a status banner and an expected timeframe on top. |

## Interaction Primitives

**Motion.** Framer Motion carries three movements, each with a meaning:

1. **Meeting** — when the deposit locks, the two side colours slide toward the escrow lane and join (300 ms).
2. **Seal** — the circular seal stamps down after the meeting (scale 1.6 → 1, spring curve, 400 ms). Only here.
3. **Transition** — page changes fade and shift by 8px (150 ms).

With `prefers-reduced-motion` all three are off; the seal appears in its final state.

**No undo.** Once a deposit is locked there is no undo; the rule lives in the contract. So the one irreversible action is preceded by a summary: who, when, how much, and the date until which a refund is full.

**Cancelling.** Every cancellation states the outcome before it asks for confirmation: "Cancel now and you get all 600.00 TRY back" or "Cancel now and the deposit goes to Dr. Aydın."

**One signature.** A client signs once per booking in their wallet.

## Accessibility Floor

- Full keyboard navigation; focus order matches visual order. The focus ring is `{colors.focus}` and always visible.
- Touch targets are at least 44×44px. Slot chips grow to that size on mobile.
- State is never conveyed by colour alone; every state label carries text.
- Countdowns and state changes are announced through `aria-live="polite"`.
- Numbers and currencies are marked up so screen readers read them correctly.
- Taken slots carry `aria-disabled` and take no focus.
- Page language is `en`. Dates, times and amounts are formatted for an international reader: `Sep 18, 2026 · 2:00 PM`, `2,000.00 TRY`.

## Key Flows

### 1. Aisha locks her first deposit (client, mobile)

Aisha is 34 and has never used crypto. She is looking for a therapist on her phone.

1. She opens Discover and types "psychologist". Suggestions appear; she picks the first.
2. On the cards, right under the price, she sees the deposit and the cancellation window: `600.00 TRY deposit · full refund up to 24h before`. She compares on that line.
3. On Dr. Elif Aydın's card she taps the "Fri 2:00 PM" chip; the profile opens with that slot selected.
4. The booking screen shows three lanes: her choices, the deposit in the middle, the provider's commitment on the other side.
5. She picks "Local currency" because she has no wallet. Bank details and a reference appear.
6. She pays. The screen advances on its own; Aisha never refreshes.
7. **The climax:** the two colours meet in the middle and the seal stamps down: "You're set." The screen states that 600.00 TRY is in escrow, that cancelling before Sep 17 at 2:00 PM returns all of it, and shows the transaction's record on chain.
8. She taps "Add to calendar" and leaves. She never created an account.

### 2. Cem cancels in time (client, before the window closes)

1. He opens "My bookings". The card shows a countdown: `Free cancellation · 2d 19h`.
2. He taps "Cancel". The screen states the outcome: "Cancel now and you get all 600.00 TRY back."
3. He confirms and signs once in his wallet.
4. The state becomes "Refunded" and the refund's record appears on the card.

### 3. Dr. Elif cashes out (provider, desktop)

1. After the session the client confirms it happened and the deposit is released.
2. In her panel Dr. Elif sees the "Released" state and her withdrawable total.
3. She taps "Cash out". Identity verification is asked once and never repeated.
4. The amount is sent to her bank account; the state moves to "On its way" and then "Landed".
5. She sees no crypto vocabulary at any step. Her panel speaks in her local currency throughout.

### 4. A provider applies (curated onboarding)

1. They fill in "Become a provider": name, title, service, credentials, price, deposit rate, cancellation window.
2. An application-status page shows the pending state; the panel opens read-only.
3. An admin approves; the profile appears on the marketplace and the "Approved provider" badge activates.
4. Once their first session completes, the verified-session counter reads 1.

## Time and Priority

The development budget is about two days. Not every surface will land at once; the order is:

1. **Non-negotiable:** the Discover list (it can ship without search), provider profile, booking and payment, locked confirmation, My bookings, provider panel, cash out.
2. **Next:** search and autocomplete, the filter rail, the application form and admin approval (for the demo, providers can be seeded pre-approved).
3. **Vision:** writing reviews, editing the provider profile, a native mobile app, advanced filters.

The deposit pill, the escrow lane and the seal moment never leave scope; they are what makes the product different.

## Open Questions

- ~~Categories~~ — **approved (2026-09-16):** therapy and wellbeing, education and lessons, consulting, fitness and beauty.
- **Responsive priority** is an assumption: the client flow is mobile-first, the provider panel desktop-first.
- ~~How the balance is paid~~ — **decided (2026-09-16):** the balance is due before the session; the client can pay in person or through Pactly. The booking carries the payment state (PRD FR22, Story 3.7).
- ~~The admin panel~~ — **recorded (2026-09-16):** added to the PRD as Epic 4 (Stories 4.1–4.2).
- **Multi-currency presentation** is deferred: the demo shows the anchor's TRY rail, but no component may hard-code it (PRD NFR12). How a second anchor's currency gets chosen is an open product question.
