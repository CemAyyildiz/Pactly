---
name: Pactly
description: A trust-backed booking marketplace for appointment-based services — the "Two Sides" visual system
status: final
updated: 2026-09-17
sources:
  - "../../prd.md"
colors:
  stone: '#DCDAD3'
  paper: '#F2F1EC'
  card: '#FFFFFF'
  ink: '#111111'
  faint: '#6B6960'
  line: '#CFCDC5'
  you: '#E8B93A'
  you-ink: '#3A2A00'
  you-soft: '#F7EAC6'
  pro: '#164E4A'
  pro-text: '#D8ECE8'
  pro-soft: '#DCEAE7'
  escrow: '#111111'
  escrow-text: '#F2F1EC'
  alert: '#B4462A'
  alert-soft: '#F5E0D9'
  focus: '#1F3BE0'
typography:
  display:
    fontFamily: "'Darker Grotesque', system-ui, sans-serif"
    fontWeight: 900
    lineHeight: '0.85'
    letterSpacing: '-0.01em'
  heading:
    fontFamily: "'Familjen Grotesk', system-ui, sans-serif"
    fontWeight: 700
    lineHeight: '1.15'
  body:
    fontFamily: "'Familjen Grotesk', system-ui, sans-serif"
    fontSize: '16px'
    fontWeight: 400
    lineHeight: '1.5'
  small:
    fontFamily: "'Familjen Grotesk', system-ui, sans-serif"
    fontSize: '14px'
    lineHeight: '1.45'
  label:
    fontFamily: "'Martian Mono', ui-monospace, monospace"
    fontSize: '12px'
    fontWeight: 500
    letterSpacing: '0.02em'
  numeric:
    fontFamily: "'Darker Grotesque', system-ui, sans-serif"
    fontWeight: 900
    note: 'font-variant-numeric: tabular-nums — every money and time value'
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
    background: '{colors.you}'
    color: '{colors.you-ink}'
    border: '1.5px solid {colors.you-ink}'
    radius: '{rounded.md}'
    padding: '14px 20px'
    fontSize: '16px'
    fontWeight: 600
  button-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.md}'
    padding: '16px 24px'
    note: 'The only button that locks a deposit'
  button-ghost:
    background: 'transparent'
    color: '{colors.ink}'
    border: '1.5px solid {colors.ink}'
    radius: '{rounded.md}'
  card-provider:
    background: '{colors.card}'
    border: '1.5px solid {colors.ink}'
    radius: '{rounded.lg}'
    padding: '{spacing.card-pad}'
  badge-verified:
    background: '{colors.pro-soft}'
    color: '#0F3D3A'
    border: '1px solid #B8D5CF'
    radius: '{rounded.full}'
    fontSize: '12px'
  chip-slot:
    background: '{colors.you}'
    color: '{colors.you-ink}'
    border: '1.5px solid {colors.you-ink}'
    radius: '{rounded.sm}'
    fontSize: '13px'
  chip-slot-taken:
    background: 'transparent'
    color: '{colors.faint}'
    border: '1.5px dashed {colors.line}'
  pill-deposit:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.full}'
    fontSize: '12.5px'
    note: 'Deposit amount + free-cancellation window. Opens with a mustard dot.'
  band-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    note: 'The middle column of the booking screen — the escrow lane'
  seal-locked:
    color: '{colors.escrow}'
    note: 'The circular seal stamped on confirmation. Used nowhere else.'
---

# Pactly — Visual System (Two Sides)

> Source: `../../prd.md`. Behaviour and flows live in `EXPERIENCE.md`. Where a mockup disagrees with these two documents, the documents win.

## Brand & Style

Pactly is a product about a **promise**. A booking is a promise two people make to each other, and the deposit is what that promise is worth. The whole visual system grows out of that idea, and it takes its name from it: **Two Sides**.

At the core of the system is a colour rule. Every screen has three zones, and the viewer knows which one they are in by its colour:

- **Mustard** is the client's side. Everything they choose, tap and decide.
- **Deep teal** is the provider's side. Their identity, their approval, their commitment.
- **Black** is the escrow. It belongs to no one. The deposit, the contract and the chain records live here.

This is a legible rule, not decoration. The colour of an element tells you whose it is.

The tone is plainspoken and quietly confident. No heavy shadows, no glass, no gradients, no decorative illustration. Depth comes from colour fields and crisp 1.5px edges. The product handles serious money but does not sound like a bank: it says "You're set." rather than "Your transaction has been completed successfully."

**Deliberately avoided:** generic SaaS looks (blue accent + soft grey card + rounded corner + faint shadow), crypto aesthetics (neon, dark gradients, glow), stock illustration, emoji used as icons.

## Colors

| Token | Value | Role |
|---|---|---|
| `{colors.stone}` | #DCDAD3 | Ground outside the app, breathing room |
| `{colors.paper}` | #F2F1EC | Page background |
| `{colors.card}` | #FFFFFF | Card and panel surface |
| `{colors.ink}` | #111111 | Text, borders, escrow zone |
| `{colors.faint}` | #6B6960 | Secondary text |
| `{colors.line}` | #CFCDC5 | Divider inside a card (borders use `ink`) |
| `{colors.you}` | #E8B93A | The client's side: selection, primary action, open slot |
| `{colors.you-ink}` | #3A2A00 | Text on mustard |
| `{colors.pro}` | #164E4A | The provider's side: identity, approval, provider panel |
| `{colors.pro-soft}` | #DCEAE7 | Verified-session badge ground |
| `{colors.alert}` | #B4462A | Warning about an irreversible outcome |
| `{colors.focus}` | #1F3BE0 | Keyboard focus ring — used nowhere else |

**Mustard appears only where the client acts.** A taken slot cannot be mustard; a success message cannot be mustard. If the client can tap it, it is mustard.

**Deep teal is never interactive.** It says who the provider is and what they commit to. When the provider is in their own panel, teal is the ground of their side — the action colour there is still mustard.

**Black is both the text colour and the escrow colour.** A surface painted black holds money or contract truth: the escrow lane, the deposit pill, the lock button, transaction records.

**Terracotta is rare.** It marks an irreversible outcome only: the end of the free-cancellation window, the transfer of a deposit to the provider, a past appointment. It is not the error colour; errors are built on `{colors.ink}` with an `{colors.alert}` border.

**Contrast:** `you-ink` on `you` and `pro-text` on `pro` both clear 4.5:1. White text on mustard is **never** used.

## Typography

Three families, three clear jobs:

- **Darker Grotesque 900** (`{typography.display}`) — large statements and numerals. Tight, wide and tall; the product's character comes from here. Used at 24px and above only.
- **Familjen Grotesk** (`{typography.body}`) — all reading text, buttons, card content.
- **Martian Mono 12px** (`{typography.label}`) — labels, step numbers, chain data, contract and transaction ids. Set in uppercase. This is where the machine speaks; it does not form sentences.

The scale is fixed: **12 · 14 · 16 · 18 · 24 · 32 · 48**. No values are invented in between.

Money and times are always set with `tabular-nums`; digits stacked in a list must align. Amounts carry their currency code and use a period as the decimal separator with comma grouping (`2,000.00 TRY`, `14.35 USDC`), so the same format holds for any currency the anchor supports. Currency symbols are never hard-coded into components.

## Layout & Spacing

The spacing scale is multiples of 4px. Page margin is `{spacing.gutter}` on desktop, `{spacing.gutter-mobile}` on mobile.

Breakpoints: **375 · 768 · 1024 · 1440**.

- **Discovery:** above 1024px, a left filter rail (232px) plus a two-column result grid. Below 1024px the filters move into a bottom sheet and results become a single column.
- **Booking:** above 1024px, three lanes (client · escrow · provider). Below 1024px the lanes stack vertically and **reorder**: provider identity on top, the client's choices in the middle, the escrow pinned to the bottom as a bar. The escrow lane is never hidden at any breakpoint.
- **Provider panel:** desktop-first, table layout. On mobile the table becomes a card list.

## Elevation & Depth

There are no shadows. Separation is built three ways:

1. **A 1.5px `{colors.ink}` border** — cards, inputs, buttons.
2. **A colour field** — a region painted in a side's colour is its own layer.
3. **An offset solid block** (`4px 4px 0`) — only for transient layers that sit above: search suggestions, dropdowns, modals.

A modal backdrop is `{colors.ink}` at 55% opacity; nothing is blurred.

## Shapes

Radii collapse to two values: controls and cards use `{rounded.md}`–`{rounded.lg}`, pill-shaped elements use `{rounded.full}`. Nothing in between.

The pill shape is reserved for three things: category tabs, badges and the deposit pill. These carry information rather than being tappable surfaces — category tabs excepted.

The logo is the system in miniature: one mustard half, one teal half, and a black line between them that both separates and joins.

## Components

**Provider card** (`{components.card-provider}`) — A 76×96px photo in the left column with a teal "APPROVED" badge at its top left. The right column carries, in order: name (`{typography.display}` 28px), title and session length, the badge row, the session price (`{typography.display}` 30px), the **deposit pill**, and the three earliest open slots. The deposit pill is non-negotiable: competing products hide the cancellation policy until checkout; Pactly shows it in the list.

**Deposit pill** (`{components.pill-deposit}`) — Black ground, mustard dot, one line: `600.00 TRY deposit · full refund up to 24h before`. It repeats in the same form on every surface where the deposit appears.

**Slot chip** (`{components.chip-slot}`) — An open slot is mustard. A taken slot uses `{components.chip-slot-taken}`: dashed and faded, never struck through, never focusable.

**Escrow lane** (`{components.band-escrow}`) — The black column down the middle of the booking screen. It holds the lock icon, the deposit amount and the contract id. The thin lines reaching out to either side are mustard on the left and teal on the right: the money comes from both sides and stops in the middle.

**Lock button** (`{components.button-escrow}`) — The only black button in the product. It is used solely for the action that puts the deposit into escrow. No other button may be black; otherwise the signal "this button commits money" loses its worth.

**Seal** (`{components.seal-locked}`) — The circular mark stamped on confirmation. Martian Mono text rotates around it carrying the two parties, the date and the promise number. Used at that moment only, never repeated elsewhere.

**Badges** — "Approved provider" (curated acceptance) and "38 verified sessions" (sessions whose deposit was released) belong to the teal family. Neither can be invented: each exists because something recorded it, on chain or in the admin queue.

The provider's own cancellation count sits beside the verified-session badge and is recorded the same way — from the chain, never by hand. It is stated plainly and never styled as an alarm: it is one fact among the others a client weighs, not a verdict, so it never takes the louder colour or the larger type.

## Do's and Don'ts

**Do**
- Apply the side colours by their rule: mustard for the client's action, teal for the provider's identity, black for escrow.
- Always show the deposit amount and the free-cancellation window together.
- Use `tabular-nums` for money and time; keep the currency code beside the amount.
- Use line-based SVG icons (Lucide or equivalent) at 1.5–2px stroke.
- Keep motion between 150–300 ms and honour `prefers-reduced-motion`.
- Keep keyboard focus visible at all times with the `{colors.focus}` ring.

**Don't**
- Use the black button for anything but locking a deposit.
- Use mustard as an information or success colour; it is an action colour.
- Use terracotta decoratively.
- Add shadows, glass, gradient grounds or glow.
- Use emoji in place of icons.
- Put more than five colours on one screen; stone and paper grounds do not count.
- Invent a font size outside the scale.
- Hard-code a currency symbol or assume a single locale.
