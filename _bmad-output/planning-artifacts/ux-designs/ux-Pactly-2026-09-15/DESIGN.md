---
name: Pactly
description: A trust-backed booking marketplace for appointment-based services — the editorial direction, with Stellar's own yellow as the single accent
status: final
updated: 2026-09-20
sources:
  - "../../prd.md"
colors:
  paper: '#FAFAF9'
  card: '#FFFFFF'
  ink: '#1C1917'
  body: '#3B3733'
  muted: '#6F6862'
  rule: '#E3DED6'
  rule-strong: '#CFC8BE'
  stellar: '#FDDA24'
  stellar-soft: '#FFF6D1'
  gold-ink: '#8A6410'
  escrow: '#14110F'
  escrow-text: '#F5F1EA'
  alert: '#9A3412'
typography:
  display:
    fontFamily: "'Libre Bodoni', Georgia, serif"
    fontWeight: 400
    note: 'Names, page-level headings, the wordmark, prices, the escrow amount, "You are set." -- nothing else. Weight stays 400/500; the mockup never bolds it.'
  body:
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: '15px'
    fontWeight: 400
    lineHeight: '1.6'
  label:
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: '11px'
    fontWeight: 500
    letterSpacing: '0.14em'
    note: 'Uppercase eyebrow labels: section labels, lane headings, field labels, the approved mark. No monospace family.'
  numeric:
    note: 'font-variant-numeric: tabular-nums on every money and time value. Serif where the number itself is the headline (a price, the escrow amount); Public Sans everywhere else (a summary row, a table cell).'
  scale:
    note: 'Editorial, not a fixed step scale: 11 · 12 · 13 · 14 · 15 · 16 · 17 · 18 · 23 · 24 · 27 · 30 · 32 · 34 · 38 · 44 · 48 · 56 -- every size `editorial-v1.html` actually renders, named in `tokens.css`, nothing invented past it.'
rounded:
  hairline: '2px'
  sm: '2px'
  DEFAULT: '3px'
  md: '3px'
  lg: '3px'
  xl: '3px'
  full: '9999px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '5': '20px'
  '6': '24px'
  '7': '28px'
  '8': '32px'
  '9': '36px'
  '10': '40px'
  '14': '56px'
  gutter: '32px'
  gutter-mobile: '20px'
  card-pad: '14px'
components:
  button-primary:
    background: 'transparent'
    color: '{colors.ink}'
    border: '1.5px solid {colors.ink}'
    radius: '{rounded.sm}'
    note: 'Carries a 3px Stellar-yellow rule along its own bottom edge (inset box-shadow), never a fill. This -- not black -- is every non-money call to action: sign in, hold a slot, continue, save, approve, release, pay the balance.'
  button-ghost:
    background: 'transparent'
    color: '{colors.body}'
    border: '1px solid {colors.rule-strong}'
    radius: '{rounded.sm}'
    note: 'Secondary/dismissive actions: cancel, sign out, try again, open a dispute.'
  button-escrow:
    background: '{colors.escrow}'
    color: '{colors.stellar}'
    radius: '{rounded.sm}'
    note: 'The Lock with Pactly button -- the only black button in the product, and the only place the yellow ever carries a word.'
  provider-row:
    note: 'An editorial list row (not a card): a 132x165px ink monogram tile, a body column, a right-hand price rail, separated from the next row by a single hairline. No card background, no border, no radius, no shadow.'
  approved-mark:
    color: '{colors.gold-ink}'
    note: 'A dot (Stellar yellow) plus small-caps text -- "Approved provider · N verified sessions" -- never a pill. The one place gold ink carries the word "Approved" as text.'
  chip-slot:
    background: 'transparent'
    color: '{colors.ink}'
    border: '1px solid {colors.rule-strong}'
    radius: '{rounded.sm}'
    note: 'A quiet, neutral chip. Selected inverts to ink-on-paper; hover marks a 3px Stellar-yellow rule along the bottom edge.'
  deposit-pill:
    background: '{colors.escrow}'
    color: '{colors.stellar}'
    radius: '{rounded.sm}'
    note: 'The provider profile aside and the booking lane: a black block, the amount itself in Stellar yellow (allowed -- it is on escrow black), the free-cancellation window beneath it in a muted on-black tone.'
  deposit-row:
    color: '{colors.ink}'
    note: 'The list row''s own plain in-row presentation: no black block inside a hairline-separated row. The bold amount carries a soft Stellar-yellow highlight behind it instead (inset box-shadow), the caption beneath it in muted ink.'
  band-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    note: 'The black column between the two booking lanes (or, below 1000px, the bar pinned to the bottom), topped with a 3px Stellar-yellow rule. The amount itself renders in the display serif, in Stellar yellow.'
  seal-locked:
    color: '{colors.stellar}'
    note: 'The circular ring stamped on confirmation, on the escrow black. Used at that moment only.'
---

# Pactly — Visual System (the editorial direction)

> Source: `../../prd.md`. Behaviour and flows live in `EXPERIENCE.md`. Where a mockup disagrees with these two documents, the documents win.
>
> **Story 3.10 note:** the owner rejected the built interface twice -- first the "Two Sides" palette (Stories 3.1-3.8), then its Discover v2 repaint (Story 3.9). The direction they accepted is the editorial one in `mockups/editorial-v1.html`: warm paper, near-black ink, Libre Bodoni over Public Sans, hairline rules, generous whitespace, and Stellar's own yellow (`#FDDA24`) as the single accent. Both earlier mockups' *palettes* are superseded by this document; where their *compositions* still inform a layout this document doesn't re-derive from scratch (the three-lane booking screen, the escrow lane in the middle, a filter rail beside the results), that structure still stands -- only its colours and type changed, again.

## Brand & Style

Pactly is a product about a **promise**. A booking is a promise two people make to each other, and the deposit is what that promise is worth. The editorial direction reads like the record of that promise: warm paper, ink, a serif for names and numbers, hairline rules dividing one fact from the next -- closer to a considered publication than a dashboard.

There is no colour system dividing the client's side from the provider's any more. Identity is carried by **type and rule**, not a second brand colour: a serif name, a small-caps label, a hairline border. The one colour with meaning is **the escrow black** -- the deposit, the contract and the chain records live there, and it belongs to no one. Everywhere else, ink is the only colour text is set in.

**Stellar's own yellow (`#FDDA24`) is the single accent**, and it is disciplined on purpose -- a colour used everywhere stops meaning anything:

- It never sits as a text colour on paper or white; it fails contrast there. A word that must read gold uses `{colors.gold-ink}` instead.
- It may carry a word only on the escrow black (the deposit amount, "Lock with Pactly"'s own label).
- Otherwise it only ever appears as a mark (a small dot beside "Approved provider"), an underline (a selected category tab, a selected payment method), a soft highlight behind a number (a deposit amount in a list row), or a 3px rule (a button's own bottom edge, the escrow lane's own top edge).
- It is never a large fill. Wherever it appears, an ink or gold-ink element carries the same meaning beside it, so nothing depends on the yellow alone (the Accessibility Floor's own "never colour alone" rule, extended to the accent itself).

The tone stays plainspoken and quietly confident. Depth comes from a hairline rule and a warm paper/card contrast, never a shadow on anything permanent -- a shadow is reserved for a layer that floats above the page (the search suggestions dropdown), exactly as before.

## Colors

| Token | Value | Role |
|---|---|---|
| `{colors.paper}` | #FAFAF9 | Page background |
| `{colors.card}` | #FFFFFF | Card and panel surface |
| `{colors.ink}` | #1C1917 | Headlines, names, the one text colour, rule-based identity |
| `{colors.body}` | #3B3733 | Body copy |
| `{colors.muted}` | #6F6862 | Secondary text, captions, eyebrow labels |
| `{colors.rule}` | #E3DED6 | The default 1px hairline: row dividers, card borders |
| `{colors.rule-strong}` | #CFC8BE | A heavier hairline: underlined inputs, unselected chip borders |
| `{colors.stellar}` | #FDDA24 | The single accent -- see "Brand & Style" for its own rules |
| `{colors.stellar-soft}` | #FFF6D1 | A soft highlight behind a number, or a halo behind the escrow dot |
| `{colors.gold-ink}` | #8A6410 | The darkened tone used whenever a word itself must read gold |
| `{colors.escrow}` | #14110F | The escrow zone: the escrow lane, the deposit pill, the Lock with Pactly button |
| `{colors.escrow-text}` | #F5F1EA | Text and icons on the escrow black |
| `{colors.alert}` | #9A3412 | A warning about an irreversible outcome |

**Black is the money colour**, not a second identity colour. A surface painted the escrow black holds money or contract truth -- the escrow lane, the deposit pill, the Lock with Pactly button -- and nothing else may be black. `button-primary` and `button-ghost` never use it, on hover or otherwise; a primary action's own weight comes from the ink border and the Stellar-yellow rule beneath it, never from a fill that could be mistaken for the money colour.

**Contrast:** body and muted text on paper or card both clear 4.5:1; gold ink on paper clears it too. Escrow-text on the escrow black clears it by a wide margin. A failing pairing is corrected before it ships, never shipped as "close enough".

## Typography

Two families cover every job:

- **Libre Bodoni** (`{typography.display}`) — display only: a page's own heading, a provider's name, a price, the escrow amount, the "You're set." confirmation. Weight stays 400-500; this face is never bolded past that.
- **Public Sans** (`{typography.body}`) — everything else: reading text, buttons, meta lines, form fields, table cells, and every money or time value that is not itself the headline (a summary row's amount, a table cell) uses this at a bold weight with `tabular-nums`.
- **Public Sans, uppercase** (`{typography.label}`) — eyebrow labels, lane headings, field labels, the approved mark's own text. 11px, `letter-spacing: 0.14em`. No monospace face anywhere.

The scale is editorial, not a fixed step function: every size `editorial-v1.html` actually renders has a token in `tokens.css` (11 through 56), and nothing is invented past what the mockup shows.

Money and times are always set with `tabular-nums`; digits stacked in a list must align. Amounts carry their currency code and use a period as the decimal separator with comma grouping (`2,000.00 TRY`, `14.35 USDC`). Currency symbols are never hard-coded into components.

## Layout & Spacing

The spacing scale is multiples of 4px. Page margin is `{spacing.gutter}` on desktop, `{spacing.gutter-mobile}` on mobile.

Breakpoints: **375 · 700 · 820 · 981 · 1024 · 1440** (the mockup's own breakpoints, kept exactly where a component ports its own shape from it).

- **Discovery:** a full-width category nav (underline-selected tabs, always horizontal -- no left rail), then a single-column result list beside a narrow (216px) right-hand filter rail from 981px up. Below that the filter rail becomes a bottom sheet and the category nav still sits above the list.
- **Booking:** three lanes (client · escrow · provider) from 1000px up. Below that the lanes stack and reorder: provider identity on top, the client's choices in the middle, the escrow pinned to the bottom as a bar. The escrow lane is never hidden at any breakpoint.
- **Provider panel:** desktop-first, table layout. On mobile the table becomes a card list.

## Elevation & Depth

Separation is built two ways now, not three:

1. **A hairline** — `{colors.rule}` for row dividers and card borders; `{colors.rule-strong}` for an underlined input or an unselected chip. This carries almost everything: the old "colour field marks a zone" rule is gone along with the zones themselves.
2. **A soft shadow, for transient layers only** — a floating layer above the page (the search suggestions dropdown) may use a real, softly blurred shadow. Permanent content -- rows, cards, tables -- never carries one.

A modal backdrop is `{colors.ink}` at 55% opacity; nothing else is blurred.

## Shapes

Radii run 2–3px almost everywhere -- a deliberate, near-square departure from the rounded-card language of both earlier mockups. `{rounded.full}` remains defined but nothing in the product currently uses it; the pill shape this system once reserved for badges and the deposit pill is retired along with them.

The logo is set in Libre Bodoni.

## Components

**Provider row** (`{components.provider-row}`) — the editorial list's own row, not a card: a monogram tile (ink ground, paper initials -- there is no photo field), a body column (the approved mark, the serif name, one meta line combining title, session format, length, location, verified-session count and the plainly-stated cancellation count, and the earliest open slots), and a right-hand rail (the price, then the deposit row beneath it). Separated from the next row by a single hairline; no card background, border, radius or shadow.

**Approved mark** (`{components.approved-mark}`) — a small Stellar-yellow dot plus small-caps gold-ink text, never a pill: "Approved provider · N verified sessions". Discover only ever lists approved providers, so this mark is unconditional on every row; the provider header repeats the same mark wherever a provider's identity appears.

**Slot chip** (`{components.chip-slot}`) — an open slot is a quiet, bordered chip; picking it inverts it to ink-on-paper. Hovering marks a 3px Stellar-yellow rule along its own bottom edge -- the accent as an interaction cue, never a fill.

**Deposit pill / deposit row** (`{components.deposit-pill}` / `{components.deposit-row}`) — the same fact, two presentations. The black pill (provider profile aside, booking lane) carries the amount in Stellar yellow, since it sits on escrow black. The plain deposit row (a list row's own price rail) never puts a black block inside a hairline-separated row -- its bold amount carries a soft Stellar-yellow highlight behind it instead. Both always pair the amount with the free-cancellation window.

**Escrow lane** (`{components.band-escrow}`) — the black column between the two booking lanes, topped with a 3px Stellar-yellow rule. Holds the lock icon, the deposit amount (display serif, Stellar yellow), the hold countdown, and the escrow proof once locked.

**Lock with Pactly button** (`{components.button-escrow}`) — the only black button in the product, and the only place the accent carries a word: black ground, Stellar-yellow label. No other button may be black, on hover or otherwise; otherwise the signal "this button commits money" loses its worth.

**Escrow proof** — a secondary label under the funded state reads "ESCROW POWERED BY TRUSTLESS WORK ON STELLAR", followed by the shortened contract or transaction record, in a muted on-black tone with Stellar-yellow links. Evidence, never a competing CTA.

**Seal** (`{components.seal-locked}`) — the circular ring stamped on confirmation, in Stellar yellow on the escrow black, with its "You're set." headline in the display serif. Used at that moment only.

**Booking lanes** — the client and provider lanes share one warm off-white ground (`--color-lane`, `#FCFBF8`); the provider side is marked only by a hairline border, never a second brand colour. Identity here is carried entirely by the serif name and the approved mark.

**State label** — a small bordered tag, text always present regardless of tone. A generic released/resolved outcome reads in gold ink with a Stellar-yellow rule beneath it, rather than inventing a colour the palette does not have.

## Do's and Don'ts

**Do**
- Keep the accent disciplined: a mark, an underline, a soft highlight, or a 3px rule -- never a large fill, never text on paper or white.
- Keep black as the money colour only: the escrow lane, the deposit pill, and the Lock with Pactly button. Nothing else.
- Carry identity with type and rule (a serif name, a hairline border), never a second brand colour.
- Use `tabular-nums` for money and time; keep the currency code beside the amount.
- Keep motion between 150–400 ms and honour `prefers-reduced-motion`.
- Keep keyboard focus visible at all times, with a visible ink ring.
- Keep touch targets at least 44×44px even where the mockup's own control is drawn smaller.

**Don't**
- Use the escrow black for any button but Lock with Pactly, ever -- not even on hover.
- Use the Stellar yellow as a text colour on paper or white.
- Add a shadow to permanent content (rows, cards, tables); shadows are reserved for transient layers.
- Use emoji in place of icons.
- Invent a font size the mockup doesn't render.
- Hard-code a currency symbol or assume a single locale.
