---
name: Pactly
description: A trust-backed booking marketplace for appointment-based services — the Editorial Warmth direction (warm paper, serif mastheads, Pactly blue and escrow black as the trust colours, terracotta as the decorative accent)
status: final
updated: 2026-09-20
sources:
  - "../../prd.md"
colors:
  paper: '#FAF6EE'
  canvas: '#F2E9D6'
  card: '#FFFDF8'
  lane: '#FFFDF8'
  ink: '#1C1A15'
  body: '#2B271F'
  muted: '#7A7160'
  rule: '#E7DCC2'
  rule-strong: '#D8C99F'
  accent: '#1F4BFF'
  accent-soft: '#E8EDFF'
  accent-ink: '#1636C9'
  warm: '#B1502A'
  warm-soft: '#F5E3D4'
  warm-ink: '#7C3417'
  escrow: '#17140E'
  escrow-text: '#FAF6EE'
  escrow-muted: '#9A8F78'
  escrow-line: '#332C20'
  ok: '#1A7A4C'
  alert: '#9A3412'
  alert-soft: '#FBEAE0'
  disabled-text: '#A89D89'
typography:
  display:
    fontFamily: "'Newsreader', Georgia, serif"
    fontWeight: 600
    note: 'Mastheads (every page title), provider names, prices, the escrow amount, "You are set.", and the italic lede/quote lines under a masthead or on the featured card. Weights 500-600 only; the face is never bolded past 600.'
  body:
    fontFamily: "'Instrument Sans', system-ui, sans-serif"
    fontSize: '15px'
    fontWeight: 400
    lineHeight: '1.55'
  label:
    fontFamily: "'Instrument Sans', system-ui, sans-serif"
    fontSize: '11px'
    fontWeight: 600
    letterSpacing: '0.14em'
    note: 'Uppercase eyebrows: the line above every masthead, section labels, lane headings, the approved mark. Eyebrows above a masthead and section labels are set in {colors.warm}; field labels and lane headings stay {colors.muted}.'
  numeric:
    note: 'font-variant-numeric: tabular-nums on every money and time value. Serif where the number itself is the headline (a price, the escrow amount); Instrument Sans everywhere else.'
  scale:
    note: 'Editorial, not a fixed step scale: 11 · 12 · 12.5 · 13 · 14 · 15 · 16 · 17 · 18 · 22 · 23 · 24 · 27 · 28 · 30 · 32 · 34 · 38 · 44 · 48 · 56, named in `tokens.css`. Mastheads clamp between 2rem and 44px (56px on Discover) with the viewport.'
rounded:
  hairline: '6px'
  sm: '8px'
  md: '10px'
  lg: '14px'
  xl: '14px'
  full: '9999px'
  note: 'Cards, banners, trust items and the filter rail use lg. Buttons, category tabs, the filters trigger, deposit pills and the featured badge are full pills. Photo/monogram tiles use md-lg.'
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
  gutter: '22px'
  gutter-mobile: '20px'
  card-pad: '16px'
icons:
  library: '@phosphor-icons/react'
  note: 'Every icon is a Phosphor SVG component (`*Icon` names). Decorative icons beside visible text are `aria-hidden`; a standalone icon carries an aria-label. Never a text glyph (✓, →, ×), never emoji, never an ad-hoc inline SVG. Trust icons (shield, seal, pin on the featured card) sit in {colors.accent}; location pins on compact cards and the provider header sit in {colors.warm}.'
motion:
  library: 'motion (motion/react)'
  note: 'Entrance only, and always gated by useReducedMotion: mastheads rise 8px / fade in 300ms; the featured card 12px / 350ms; compact cards 10px / 300ms with a 40ms stagger (capped at index 10). Nothing animates on scroll — results must be readable the moment they mount. The seal keeps its own stamp animation (EXPERIENCE.md).'
components:
  page-masthead:
    note: 'Every non-Discover page opens with `PageMasthead`: a {colors.warm} eyebrow with a Phosphor icon, the serif title, an optional italic lede, and a right-hand actions slot (sign out, sibling links). A hairline in {colors.rule-strong} closes it. Discover renders its own larger masthead inline.'
  masthead-discover:
    note: 'The Discover masthead: eyebrow "Pactly Journal — local appointments", the 56px serif "Discover, held in trust", an italic lede, then a three-item trust strip (shield / policy / live escrow status) as small cards.'
  button-primary:
    background: '{colors.accent}'
    color: '#FFFFFF'
    radius: '{rounded.full}'
    note: 'A blue pill. Every non-money call to action: sign in, hold a slot, continue, save, approve, release, pay the balance, and the card CTAs ("Lock with Pactly →", "Lock"). Hover darkens to {colors.accent-ink}.'
  button-ghost:
    background: 'transparent'
    color: '{colors.body}'
    border: '1px solid {colors.rule-strong}'
    radius: '{rounded.full}'
    note: 'Secondary/dismissive actions: cancel, sign out, try again, open a dispute, "List your shop" in the top bar (ink border there).'
  button-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.full}'
    note: 'The Lock with Pactly button on the booking screen -- the only black button in the product.'
  card-provider-featured:
    note: 'The first Discover result: a full-width hero card ({colors.card}, {colors.rule-strong} border, xl radius) with a 4:3 photo/monogram tile carrying a {colors.warm} "Featured near you" badge, a warm-ink category eyebrow, the 30px serif name, the role, an italic serif quote about the escrow, pin/clock/seal meta in {colors.accent}, and a right column with the price, the deposit row and the blue pill CTA. The whole card is a stretched link to the profile.'
  card-provider-compact:
    note: 'Every other result: a {colors.card} card, {colors.rule} border, lg radius, 52px photo/monogram tile, serif name with a {colors.accent} seal when verified, role, pin/clock meta in {colors.warm}, the deposit row (caption truncates with an ellipsis), and a foot row with the bold price and a "Lock →" text link whose arrow nudges 3px on hover.'
  trust-strip:
    note: 'Three small cards under the Discover masthead: a shield ("No blind prepay"), a policy icon ("Clear booking policy") and a pulse in {colors.ok} ("Trustless Work escrow · operational").'
  category-tab:
    note: 'Pill chips with a {colors.rule-strong} border on {colors.card}; the selected one inverts to {colors.ink} on {colors.paper}. The count sits at 60% opacity.'
  approved-mark:
    color: '{colors.accent-ink}'
    note: 'A {colors.accent} dot plus small-caps blue-ink text -- "Approved provider · N verified sessions" -- never a pill. Blue because approval is a trust fact, not decoration.'
  provider-header:
    note: 'Photo tile, the approved mark, the 44px serif name, title · category, then the location with a {colors.warm} Phosphor pin.'
  chip-slot:
    background: 'transparent'
    color: '{colors.ink}'
    border: '1px solid {colors.rule-strong}'
    radius: '{rounded.sm}'
    note: 'A quiet, neutral chip; selected inverts to ink-on-paper.'
  deposit-pill:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.full}'
    note: 'Provider profile aside, booking lane, landing mock card: a black pill, the amount bold in escrow-text, "deposit", then the free-cancellation window in {colors.escrow-muted}.'
  deposit-row:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    radius: '{rounded.full}'
    note: 'The card''s own in-row copy of the same fact: a smaller black pill with a blue dot, amount, "deposit" and the window. Inside a compact card it is full-width and its caption truncates rather than overflowing.'
  band-escrow:
    background: '{colors.escrow}'
    color: '{colors.escrow-text}'
    note: 'The black column between the two booking lanes (or, below 1000px, the bar pinned to the bottom), topped with a 3px {colors.accent} rule. The amount renders in the display serif in {colors.accent}.'
  seal-locked:
    color: '{colors.accent}'
    note: 'The circular ring stamped on confirmation, on the escrow black. Used at that moment only.'
---

# Pactly — Visual System (Editorial Warmth)

> Source: `../../prd.md`. Behaviour and flows live in `EXPERIENCE.md`. The running app (`frontend/src/styles/tokens.css`, `editorial.css`, `base.css`) is the composition reference now; the HTML mockups in `mockups/` are historical and no longer describe what ships.
>
> **History:** the owner rejected the built interface three times -- the "Two Sides" palette (Stories 3.1-3.8), its Discover v2 repaint (Story 3.9, cool grey + blue), and the Libre Bodoni/Stellar-yellow editorial pass (Story 3.10). On 2026-09-20 a warm editorial prototype of Discover was built as an exploration and accepted outright ("switch to this, whole app"). This document describes that direction. Token *names* in `tokens.css` were kept across every pivot so components never changed; only the values, the icon set and the page-level compositions did.

## Brand & Style

Pactly is a product about a **promise**. A booking is a promise two people make to each other, and the deposit is what that promise is worth. Editorial Warmth reads like a considered local publication recording that promise: warm paper, near-black ink, a serif for names and headlines, italic serif for the one sentence that explains the escrow, hairline rules dividing one fact from the next, generous whitespace. Discover is literally framed as "Pactly Journal — local appointments".

Three colours carry meaning, and each has one job:

- **Escrow black** (`{colors.escrow}`) is the money colour. The deposit pill, the deposit row, the escrow lane and the Lock with Pactly button live there and nowhere else. No other button is ever black, on hover or otherwise.
- **Pactly blue** (`{colors.accent}`) is the trust and action colour: every primary button, the verified seal, the approved mark, trust-strip icons, the escrow lane's top rule and amount. It never decorates.
- **Terracotta** (`{colors.warm}`) is decoration only: masthead eyebrows, section labels, the landing kicker, the "Featured near you" badge, category eyebrows, location pins. It never touches a number, a state, or a control that moves money -- so the deposit vocabulary never competes with ornament.

Identity is otherwise carried by **type and rule**, never a second brand colour per side: a serif name, a small-caps eyebrow, a hairline border. Depth comes from the paper/card contrast and hairlines; a shadow is reserved for a layer that floats above the page (the search suggestions dropdown).

## Colors

| Token | Value | Role |
|---|---|---|
| `{colors.paper}` | #FAF6EE | Page background (`.page`, `.editorial-page`, the landing hero) |
| `{colors.canvas}` | #F2E9D6 | The body canvas behind pages, the landing story band, monogram tiles |
| `{colors.card}` | #FFFDF8 | Cards, banners, the top bar, the filter rail, booking lanes |
| `{colors.ink}` | #1C1A15 | Headlines, names, selected tabs, focus ring |
| `{colors.body}` | #2B271F | Body copy |
| `{colors.muted}` | #7A7160 | Secondary text, captions, ledes, field labels |
| `{colors.rule}` | #E7DCC2 | The default hairline: card borders, dividers |
| `{colors.rule-strong}` | #D8C99F | A heavier hairline: the masthead rule, the featured card's border, chip borders, underlined inputs |
| `{colors.accent}` | #1F4BFF | Trust and action: primary buttons, seal, approved dot, trust icons |
| `{colors.accent-soft}` | #E8EDFF | Soft blue ground: the landing "how it works" icon discs, the hero highlight |
| `{colors.accent-ink}` | #1636C9 | Blue as text: approved mark, card "Lock →" links, primary hover |
| `{colors.warm}` | #B1502A | Decorative accent: eyebrows, kicker dot, featured badge, pins |
| `{colors.warm-soft}` | #F5E3D4 | Warm ground: the landing kicker pill, the featured tile gradient |
| `{colors.warm-ink}` | #7C3417 | Warm as text: category eyebrow on the featured card, kicker text, monogram initials |
| `{colors.escrow}` | #17140E | The money colour (see above) |
| `{colors.escrow-text}` | #FAF6EE | Text on escrow black |
| `{colors.escrow-muted}` | #9A8F78 | The cancellation-window caption on escrow black |
| `{colors.ok}` | #1A7A4C | Live/positive: the escrow status pulse, released states |
| `{colors.alert}` | #9A3412 | A warning about an irreversible outcome; the countdown under 6h |
| `{colors.alert-soft}` | #FBEAE0 | Alert banner ground |

**Contrast:** body and muted text on paper or card clear 4.5:1; warm-ink and accent-ink on paper clear it; escrow-text on escrow black clears it by a wide margin. `{colors.warm}` at 11-12px eyebrow size is always paired with weight 600 and letter-spacing, and never carries information on its own.

## Typography

Two families cover every job:

- **Newsreader** (`{typography.display}`) — display: every page masthead, provider names on cards and headers, prices where the number is the headline, the escrow amount, "You're set.", and the italic ledes/quotes. Weight 500-600.
- **Instrument Sans** (`{typography.body}`) — everything else: reading text, buttons, meta lines, form fields, table cells, non-headline money and time values at weight 600-700 with `tabular-nums`.
- **Instrument Sans, uppercase** (`{typography.label}`) — eyebrows, section labels, lane headings, field labels, the approved mark. 11-12px, `letter-spacing: 0.14em`, weight 600.

Mastheads are fluid: `clamp(2rem, 4vw, 44px)` on every page, `clamp(2.4rem, 5vw, 56px)` on Discover. Line-height 1.02-1.05, letter-spacing -0.01em.

Money and times are always set with `tabular-nums`; digits stacked in a list must align. Amounts carry their currency code and use a period as the decimal separator with comma grouping (`2,000.00 TRY`, `14.35 USDC`). Currency symbols are never hard-coded into components.

## Layout & Spacing

The spacing scale is multiples of 4px. Page width is 1180px; margin is `{spacing.gutter}` on desktop, `{spacing.gutter-mobile}` on mobile.

Breakpoints: **375 · 700 · 720 · 820 · 900 · 1000 · 1024 · 1440**.

- **Discover:** masthead → trust strip → search row (search box + pill "Filters" trigger) → pill category tabs → a 260px sticky filter rail beside the results from 901px up (the rail hides below; the Filters trigger opens the bottom sheet). Results are one featured hero card, then a responsive grid of compact cards (`minmax(260px, 1fr)`).
- **Every other page:** `PageMasthead` on top, then the page's own content in `.card`s or lists.
- **Booking:** three lanes (client · escrow · provider) from 1000px up. Below that the lanes stack and reorder: provider identity on top, the client's choices in the middle, the escrow pinned to the bottom as a bar. The escrow lane is never hidden at any breakpoint.
- **Provider panel:** desktop-first, table layout. On mobile the table becomes a card list.

## Elevation & Depth

1. **A hairline** — `{colors.rule}` for card borders and dividers; `{colors.rule-strong}` for the masthead rule, the featured card, chips and underlined inputs.
2. **Paper on canvas** — a page's paper sits on the darker canvas; cards sit on paper. That two-step contrast is the only "elevation" permanent content gets.
3. **A soft shadow, for transient layers only** — the search suggestions dropdown. Permanent content never carries one.

A modal backdrop is `{colors.ink}` at 55% opacity; nothing else is blurred.

## Shapes

Soft and rounded: cards, banners, the filter rail and trust items at `{rounded.lg}` (14px); the featured card at `{rounded.xl}`; photo tiles at 10-14px. Buttons, category tabs, the Filters trigger, the deposit pill/row and the featured badge are full pills. Slot chips keep `{rounded.sm}`. The near-square 2-3px radii of the previous editorial pass are gone.

The logo is set in Newsreader.

## Icons

Phosphor (`@phosphor-icons/react`) is the only icon source; components import the `*Icon`-suffixed names. Semantics follow use, not glyph: an icon beside visible text is `aria-hidden`; an icon that stands alone carries an `aria-label` ("Verified provider"). Weight `fill` for trust/meta icons on the featured card and the provider header, `regular` for meta on compact cards, `bold` for eyebrow icons and arrows. No emoji, no text glyphs, no hand-drawn inline SVG.

## Motion

`motion` (`motion/react`) carries entrance animation, always through `useReducedMotion`: a masthead rises 8px and fades in over 300ms; the featured card 12px/350ms; compact cards 10px/300ms with a 40ms stagger capped at the tenth card. Animation fires on mount, never on scroll, so a result list is readable the instant it renders. The seal's stamp and the booking screen's "meeting" stay as `EXPERIENCE.md` specifies them. Hover motion is limited to colour/border transitions (150-300ms) and the compact card's 3px arrow nudge.

## Components

See the `components` frontmatter for each block's tokens; the behavioural notes live in `EXPERIENCE.md`. The ones that define the language:

**Page masthead** (`{components.page-masthead}`) — the shared header of every non-Discover page (`PageMasthead`): warm eyebrow + icon, serif title, italic lede, right-hand actions, a strong hairline underneath. Signed-out states use the lede for the sign-in sentence.

**Discover masthead and trust strip** (`{components.masthead-discover}`, `{components.trust-strip}`) — the marketplace's own front page: the journal eyebrow, the 56px title, the lede, then three trust cards.

**Featured and compact provider cards** (`{components.card-provider-featured}`, `{components.card-provider-compact}`) — the first result is a hero, the rest a grid. Both are stretched links; the slot/CTA controls sit above the link for hit-testing so a `<button>` is never nested in an `<a>`. The skeleton (six on first load) matches the compact card.

**Deposit pill / deposit row** (`{components.deposit-pill}` / `{components.deposit-row}`) — the same fact, two sizes, both on escrow black, both always pairing the amount with the free-cancellation window.

**Escrow lane, Lock with Pactly, escrow proof, seal** — unchanged in role from the previous system: black holds the money, blue marks the amount and the rule, the proof line reads "Escrow powered by Trustless Work on Stellar" and is never the CTA.

**State label** — a small bordered tag, text always present regardless of tone.

## Do's and Don'ts

**Do**
- Open every page with a masthead (eyebrow + serif title); Discover gets the big one.
- Keep black as the money colour only; keep blue for trust and action; keep terracotta decorative.
- Use Phosphor for every icon and hide decorative ones from the accessibility tree.
- Use `tabular-nums` for money and time; keep the currency code beside the amount.
- Gate every entrance animation on `useReducedMotion`; animate on mount, not on scroll.
- Keep keyboard focus visible at all times, with a visible ink ring.
- Keep touch targets at least 44×44px.

**Don't**
- Use the escrow black for any button but Lock with Pactly, ever -- not even on hover.
- Put terracotta on a number, a state label, a deposit, or any control that commits money.
- Reintroduce the cool-grey `#F4F5F7`-era values or the `.page-header` row; `PageMasthead` replaced it.
- Add a shadow to permanent content; shadows are reserved for transient layers.
- Use emoji, text glyphs or inline SVG in place of Phosphor icons.
- Hard-code a currency symbol or assume a single locale.
