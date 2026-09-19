---
name: Pactly
description: A trust-backed booking marketplace for appointment-based services — the "Two Sides" visual system, realigned on Discover v2
status: final
updated: 2026-09-20
sources:
  - "../../prd.md"
colors:
  bg: '#F4F5F7'
  card: '#FFFFFF'
  ink: '#111318'
  muted: '#5C6370'
  line: '#E3E5EA'
  client: '#1F4BFF'
  client-deep: '#1636C9'
  client-soft: '#E8EDFF'
  success: '#1A7A4C'
  pro: '#164E4A'
  pro-text: '#D8ECE8'
  pro-soft: '#DCEAE7'
  escrow: '#111318'
  escrow-text: '#F4F5F7'
  alert: '#B4462A'
  alert-soft: '#F5E0D9'
  focus: '#1F3BE0'
typography:
  display:
    fontFamily: "'Newsreader', Georgia, 'Times New Roman', serif"
    fontWeight: 600
    lineHeight: '1.05'
    letterSpacing: '-0.01em'
    note: 'Display numbers and page titles only -- a list item''s own inline heading (a provider card, a booking card) is body weight, not display.'
  heading:
    fontFamily: "'Instrument Sans', system-ui, sans-serif"
    fontWeight: 700
    lineHeight: '1.2'
  body:
    fontFamily: "'Instrument Sans', system-ui, sans-serif"
    fontSize: '16px'
    fontWeight: 400
    lineHeight: '1.5'
  small:
    fontFamily: "'Instrument Sans', system-ui, sans-serif"
    fontSize: '14px'
    lineHeight: '1.45'
  label:
    fontFamily: "'Instrument Sans', system-ui, sans-serif"
    fontSize: '12px'
    fontWeight: 600
    letterSpacing: '0.02em'
    note: 'Uppercase eyebrow labels, step numbers, badge text -- no longer a monospace family.'
  numeric:
    fontFamily: "'Instrument Sans', system-ui, sans-serif"
    fontWeight: 700
    note: 'font-variant-numeric: tabular-nums — every money and time value. Bold body weight, not the display family (money in a card or a lane is a number, not a title).'
  scale:
    note: '12 · 14 · 16 · 18 · 24 · 32 · 48 — no values in between'
rounded:
  sm: '6px'
  DEFAULT: '10px'
  md: '10px'
  lg: '12px'
  xl: '14px'
  full: '9999px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '5': '20px'
  '6': '24px'
  '8': '32px'
  '10': '40px'
  gutter: '24px'
  gutter-mobile: '16px'
  card-pad: '14px'
components:
  button-primary:
    background: '{colors.client}'
    color: '{colors.escrow-text}'
    border: 'none'
    radius: '{rounded.md}'
    padding: '14px 20px'
    fontSize: '16px'
    fontWeight: 600
  button-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.md}'
    padding: '16px 24px'
    note: 'The Lock with Pactly button — the only button that commits money'
  button-ghost:
    background: 'transparent'
    color: '{colors.ink}'
    border: '1.5px solid {colors.ink}'
    radius: '{rounded.md}'
  card-provider:
    background: '{colors.card}'
    border: '1px solid {colors.line}'
    radius: '{rounded.xl}'
    padding: '{spacing.card-pad}'
    note: 'A three-column grid: photo/monogram, body, a right-hand price rail. The deposit pill and slots form a footer row spanning the body and price columns.'
  badge-verified:
    background: '{colors.pro-soft}'
    color: '#0F3D3A'
    border: '1px solid #B8D5CF'
    radius: '{rounded.full}'
    fontSize: '12px'
  chip-slot:
    background: '{colors.client}'
    color: '{colors.escrow-text}'
    border: '1.5px solid {colors.client-deep}'
    radius: '{rounded.sm}'
    fontSize: '13px'
  chip-slot-taken:
    background: 'transparent'
    color: '{colors.muted}'
    border: '1.5px dashed {colors.line}'
  pill-deposit:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.full}'
    fontSize: '12.5px'
    note: 'Deposit amount + free-cancellation window. Opens with a client-blue dot.'
  band-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    note: 'The middle column of the booking screen — the escrow lane'
  seal-locked:
    color: '{colors.escrow}'
    note: 'The circular seal stamped on confirmation. Used nowhere else.'
---

# Pactly — Visual System (Two Sides, realigned on Discover v2)

> Source: `../../prd.md`. Behaviour and flows live in `EXPERIENCE.md`. Where a mockup disagrees with these two documents, the documents win.
>
> **Story 3.9 note:** the visual language below was repainted onto Discover v2's own palette and type (`mockups/discover-v2-marketplace.html`) after the product owner confirmed that mockup, not the "Two Sides" mockup, is the product's real reference. `mockups/booking-and-payment.html` shows the now-superseded stone/mustard/teal palette from before this change -- its layout and composition (the three-lane booking screen, the escrow lane in the middle) still stand; only its colours and type are out of date. The "Two Sides" *structure* -- three zones, three meanings -- is unchanged: only the client's colour and the two neutral families moved.

## Brand & Style

Pactly is a product about a **promise**. A booking is a promise two people make to each other, and the deposit is what that promise is worth. The whole visual system grows out of that idea, and it takes its name from it: **Two Sides**.

At the core of the system is a colour rule. Every screen has three zones, and the viewer knows which one they are in by its colour:

- **Client blue** is the client's side. Everything they choose, tap and decide.
- **Deep teal** is the provider's side. Their identity, their approval, their commitment.
- **Black** is the escrow. It belongs to no one. The deposit, the contract and the chain records live here.

This is a legible rule, not decoration. The colour of an element tells you whose it is.

The tone is plainspoken and quietly confident. Depth is now built with a cool grey ground, white cards, thin 1px lines, and a soft shadow reserved for layers that float above the page (a suggestions dropdown, a modal) -- never a hard block or a shadow on permanent content. The product handles serious money but does not sound like a bank: it says "You're set." rather than "Your transaction has been completed successfully."

## Colors

| Token | Value | Role |
|---|---|---|
| `{colors.bg}` | #F4F5F7 | Page background |
| `{colors.card}` | #FFFFFF | Card and panel surface |
| `{colors.ink}` | #111318 | Text, headline borders, escrow zone |
| `{colors.muted}` | #5C6370 | Secondary text |
| `{colors.line}` | #E3E5EA | The default 1px border for cards, tables and dividers |
| `{colors.client}` | #1F4BFF | The client's side: primary buttons, filled chips, the deposit-pill dot |
| `{colors.client-deep}` | #1636C9 | Selected/inverted client-blue states, and text on `{colors.client-soft}` |
| `{colors.client-soft}` | #E8EDFF | The client lane's own ground, and hover/active tints |
| `{colors.success}` | #1A7A4C | A generic success outcome (released, resolved) that belongs to neither side |
| `{colors.pro}` | #164E4A | The provider's side: identity, approval, provider panel -- unchanged by this realignment |
| `{colors.pro-soft}` | #DCEAE7 | Verified-session badge ground -- unchanged |
| `{colors.alert}` | #B4462A | Warning about an irreversible outcome -- unchanged |
| `{colors.focus}` | #1F3BE0 | Keyboard focus ring — used nowhere else |

**Client blue appears only where the client acts.** A taken slot cannot be blue; a success message cannot be blue. If the client can tap it, it is blue -- this is the same rule the old mustard obeyed, repainted.

**Deep teal is never interactive.** It says who the provider is and what they commit to. When the provider is in their own panel, teal is the ground of their side -- the action colour there is still client blue. Teal's own values (`{colors.pro}` / `{colors.pro-text}` / `{colors.pro-soft}`) did not change in this realignment.

**Black is both the text colour and the escrow colour.** A surface painted black holds money or contract truth: the escrow lane, the deposit pill, the lock button, transaction records. It remains the *only* black button in the product.

**Success is new and rare.** It marks a generic released/resolved outcome that belongs to neither side -- it is not a substitute for the provider's teal (which stays an identity colour, never a status colour) and not a substitute for mustard's old "action" role (client actions are blue).

**Terracotta is rare.** It marks an irreversible outcome only: the end of the free-cancellation window, the transfer of a deposit to the provider, a past appointment. It is not the error colour; errors are built on `{colors.ink}` with an `{colors.alert}` border.

**Contrast:** `{colors.escrow-text}` on `{colors.client}` and on `{colors.client-deep}`, and `{colors.ink}` on `{colors.client-soft}`, all clear 4.5:1. A saturated client-blue fill never carries dark text -- only `{colors.escrow-text}` (near-white) does, the same way the provider's dark teal only ever carries `{colors.pro-text}`.

## Typography

Two families now cover every job (down from three):

- **Newsreader** (`{typography.display}`) — display numbers and page-level titles only: the wordmark, a page's own H1 ("Discover"), a modal's own heading, the "You're set." confirmation. Weight tops out at 600 (Newsreader has no 900) with a loosened line-height near 1.05 -- a serif needs more room than the old grotesque did.
- **Instrument Sans** (`{typography.body}`) — everything else: reading text, buttons, card content, a list item's own inline heading (a provider card's name, a booking card's heading), and every money or time value. These are bold body weight (700), not the display family -- a number inside a card is data, not a title.
- **Instrument Sans, uppercase** (`{typography.label}`) — labels, step numbers, badge text. This is no longer a monospace family; Martian Mono is dropped along with Darker Grotesque and Familjen Grotesk.

The scale is fixed: **12 · 14 · 16 · 18 · 24 · 32 · 48**. No values are invented in between.

Money and times are always set with `tabular-nums`; digits stacked in a list must align. Amounts carry their currency code and use a period as the decimal separator with comma grouping (`2,000.00 TRY`, `14.35 USDC`), so the same format holds for any currency the anchor supports. Currency symbols are never hard-coded into components.

## Layout & Spacing

The spacing scale is multiples of 4px. Page margin is `{spacing.gutter}` on desktop, `{spacing.gutter-mobile}` on mobile.

Breakpoints: **375 · 768 · 1024 · 1440**.

- **Discovery:** above 1024px, a left filter rail (240px, Discover v2's own width) plus a two-column result grid. Below 1024px the filters move into a bottom sheet and results become a single column.
- **Booking:** above 1024px, three lanes (client · escrow · provider). Below 1024px the lanes stack vertically and **reorder**: provider identity on top, the client's choices in the middle, the escrow pinned to the bottom as a bar. The escrow lane is never hidden at any breakpoint.
- **Provider panel:** desktop-first, table layout. On mobile the table becomes a card list.

## Elevation & Depth

Separation is built three ways:

1. **A 1px `{colors.line}` border** — the default for cards, tables and list rows. A typing surface (the search box, a text input) keeps a heavier 1.5px `{colors.ink}` border instead, and `button-ghost`'s outline stays 1.5px `{colors.ink}` too.
2. **A colour field** — a region painted in a side's colour is its own layer (the client lane's soft blue, the provider lane's teal, the escrow lane's black).
3. **A soft shadow, for transient layers only** — a floating layer above the page (the search suggestions dropdown, a modal) may use a real, softly blurred shadow (Discover v2's own `0 12px 28px rgba(17,19,24,.1)`). Permanent content -- cards, tables, list rows -- never carries a shadow; the old "offset solid block" elevation is retired along with the palette it was tuned for.

A modal backdrop is `{colors.ink}` at 55% opacity; nothing else is blurred.

## Shapes

Radii run 10–14px for cards and controls (`{rounded.md}`–`{rounded.xl}`), pill-shaped elements use `{rounded.full}`. Nothing in between.

The pill shape is reserved for three things: category tabs, badges and the deposit pill. These carry information rather than being tappable surfaces — category tabs excepted.

The logo is set in Newsreader now, but the system's own miniature mark -- one client-blue half, one teal half, a black line between them that both separates and joins -- is unchanged.

## Components

**Provider card** (`{components.card-provider}`) — Discover v2's own three-column grid: photo/monogram, body, and a right-hand price rail, with the deposit pill and slots forming a footer row that spans the body and price columns beneath them. The 76×96px photo/monogram sits in the left column with a teal "APPROVED" badge at its top left. The body column carries, in order: name (Instrument Sans bold, 18px), title and session length, the badge row, and location. The price rail carries the session price (Instrument Sans bold, 24px). The footer carries the **deposit pill** and the three earliest open slots. The deposit pill is non-negotiable: competing products hide the cancellation policy until checkout; Pactly shows it in the list.

**Deposit pill** (`{components.pill-deposit}`) — Black ground, client-blue dot, one line: `600.00 TRY deposit · full refund up to 24h before`. It repeats in the same form on every surface where the deposit appears.

**Slot chip** (`{components.chip-slot}`) — An open slot is client blue. A taken slot uses `{components.chip-slot-taken}`: dashed and faded, never struck through, never focusable.

**Escrow lane** (`{components.band-escrow}`) — The black column down the middle of the booking screen. It holds the lock icon, the deposit amount and the contract id.

**Lock with Pactly button** (`{components.button-escrow}`) — The only black button in the product and the centerpiece of the booking flow. It is used solely for the action that funds the Trustless Work escrow. No other button may be black; otherwise the signal "this button commits money" loses its worth.

**Escrow proof** — A secondary label under the funded state reads `ESCROW POWERED BY TRUSTLESS WORK ON STELLAR`, followed by the shortened contract or transaction record. It is evidence, never a competing CTA.

**Seal** (`{components.seal-locked}`) — The circular mark stamped on confirmation, with its "You're set." headline set in the display family. Used at that moment only, never repeated elsewhere.

**Badges** — "Approved provider" (curated acceptance) and "38 verified sessions" (sessions whose deposit was released) belong to the teal family, unchanged by this realignment. Neither can be invented: each exists because something recorded it, on chain or in the admin queue. A generic *released/resolved* status label, which belongs to neither side, uses the new success green instead of teal.

The provider's own cancellation count sits beside the verified-session badge and is recorded the same way — from the chain, never by hand. It is stated plainly and never styled as an alarm: it is one fact among the others a client weighs, not a verdict, so it never takes the louder colour or the larger type.

## Do's and Don'ts

**Do**
- Apply the side colours by their rule: client blue for the client's action, teal for the provider's identity, black for escrow.
- Always show the deposit amount and the free-cancellation window together.
- Use `tabular-nums` for money and time; keep the currency code beside the amount.
- Use line-based SVG icons (Lucide or equivalent) at 1.5–2px stroke.
- Keep motion between 150–300 ms and honour `prefers-reduced-motion`.
- Keep keyboard focus visible at all times with the `{colors.focus}` ring.

**Don't**
- Use the black button for anything but locking a deposit.
- Use client blue as an information or success colour; it is an action colour -- a generic success state uses `{colors.success}` instead.
- Use terracotta decoratively.
- Add a shadow to permanent content (cards, tables, list rows); shadows are reserved for transient layers.
- Use emoji in place of icons.
- Put more than five colours on one screen; the page background does not count.
- Invent a font size outside the scale.
- Hard-code a currency symbol or assume a single locale.
