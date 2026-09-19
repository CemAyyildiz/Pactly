---
title: 'Story 3.9 — Discover v2 visual realignment'
type: 'feature'
created: '2026-09-20'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Epic 3's screens were built against DESIGN.md's "Two Sides" system (paper background, mustard and teal, Darker Grotesque / Familjen Grotesk / Martian Mono), because EXPERIENCE.md says the documents win over the mockups. The `discover-v2-marketplace.html` mockup uses a different visual language (cool grey `#F4F5F7`, blue `#1F4BFF`, Instrument Sans with Newsreader), and that is the one the product owner wants. The two mockups in the folder disagree with each other, so the product currently does not look like the Discover the owner has in mind.

**Approach:** Make Discover v2's visual language the product's, everywhere. Update DESIGN.md's tokens and the sections that describe them so future stories inherit it, then restyle the existing screens against the new tokens. The two-sided meaning survives: the client's side becomes blue, the provider's side keeps teal, and the escrow stays black.

## Boundaries & Constraints

**Always:**
- New base tokens, taken from the mockup: background `#F4F5F7`, card `#FFFFFF`, ink `#111318`, muted `#5C6370`, line `#E3E5EA`, client blue `#1F4BFF` with soft `#E8EDFF` and deep `#1636C9`, success `#1A7A4C`, escrow `#111318` on `#F4F5F7`.
- The provider's identity colour stays teal `#164E4A` (with its soft and text variants), so "two sides" still reads as two sides. Alert keeps its current red. No other new colours.
- Typography: Instrument Sans for body, labels and headings; Newsreader for display numbers and page titles. Darker Grotesque, Familjen Grotesk and Martian Mono are dropped, including their font links. Money and time keep `tabular-nums`.
- Component shapes follow the mockup: 10–14px radii, 1px `line` borders, the card as a three-column grid (photo/monogram, body, right rail), the 240px left filter rail, the search box with a 1.5px ink border and its dropdown, chips and pills as the mockup draws them.
- Meaning does not change with the paint:
  - black stays reserved for the escrow lane, the deposit pill and the "Lock with Pactly" button — still the only black button;
  - what the client can act on is blue, never mustard;
  - the provider's identity block is teal and still never interactive;
  - state is never colour-only, focus rings stay visible, targets stay at least 44px, and `prefers-reduced-motion` is still honoured.
- DESIGN.md is updated in the same change: its frontmatter tokens, the Colors, Typography and Components sections, and a short note recording that Discover v2 is now the visual reference and that `booking-and-payment.html` shows the superseded palette (its composition still stands).
- Every screen is restyled, not only Discover: provider profile, booking and payment, My bookings, both panel pages, the admin resolutions page, and the shared components.

**Never:**
- No behaviour, route, copy or data change. This is paint, type and spacing only; every test must keep passing untouched.
- No new dependency, and no CSS framework. The existing token file plus `base.css` stay the only styling mechanism.
- Do not restyle by copying the mockup's HTML: it is a static page with hard-coded data. It is the reference for look, not a source of markup.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tokens | `frontend/src/styles/tokens.css` | Carries the v2 values above and no longer defines the dropped fonts | No error expected |
| Fonts | `base.css` font import | Loads Instrument Sans and Newsreader only, each with a real fallback stack | No error expected |
| No stale token | Any component file | No reference to a removed token (`--color-you*`, the dropped font variables) remains | A build-time grep finds none |
| Lock button | Booking page | Still the only black button in the product | No error expected |
| Client action | Any client action (slot chip, Pay balance, Approve) | Blue, never mustard | No error expected |
| Provider identity | Provider header and lane | Teal, non-interactive | No error expected |
| Contrast | Body text, muted text and buttons | At least 4.5:1 against their background (3:1 for large text) | A failing pair is corrected, not shipped |
| Narrow screen | 375px width | Layout still single-column with no horizontal scroll | No error expected |

</intent-contract>

## Code Map

- `_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/mockups/discover-v2-marketplace.html` -- the visual reference. Read its `:root`, the `.search`/`.ac` block, `.body`/`.filters` (240px rail), `.card` (88px / 1fr / auto grid), chips, pills and the trust strip.
- `.../DESIGN.md` -- frontmatter tokens plus the Colors, Typography, Layout & Spacing, Elevation, Shapes and Components sections. Update these; keep the document's structure.
- `.../EXPERIENCE.md` -- states that the documents win over mockups; that rule stays, which is why DESIGN.md has to change.
- `frontend/src/styles/tokens.css`, `base.css` -- every token and component class Epic 3 built. This is where most of the work lands.
- `frontend/src/components/*`, `frontend/src/pages/**` -- read each for class names and inline styles that encode the old palette.

## Tasks & Acceptance

**Execution:**
- `DESIGN.md` -- the token and section updates, plus the note about the superseded mockup.
- `frontend/src/styles/tokens.css` -- the v2 tokens; keep names stable where the meaning is unchanged (`--color-ink`, `--color-line`, `--color-escrow`), rename the client's colour from `--color-you*` to `--color-client*`, and update every use.
- `frontend/src/styles/base.css` -- font links, base type scale, and every component class restyled to the mockup's shapes.
- `frontend/src/components/**`, `frontend/src/pages/**` -- update class names and any inline colour; no logic edits.
- `README.md` -- if it names the design system or fonts, correct it.

**Acceptance Criteria:**
- Given the running app, when Discover is opened, then it reads as the v2 mockup: cool grey ground, white cards with the photo column, blue accents, Instrument Sans, the 240px rail and the search box with its dropdown.
- Given any other screen, when it is opened, then it uses the same language, with the provider's teal and the escrow's black intact.
- Given the repository, when `npm run -w frontend typecheck` and `build` run, then both are clean, `npm run -w backend test` still passes untouched, and no removed token name remains anywhere under `frontend/src`.

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean
- `npm run -w backend test` -- expected: unchanged, all pass
- `grep -rn -- "--color-you\|Darker Grotesque\|Familjen Grotesk\|Martian Mono" frontend/src` -- expected: no matches

**Manual checks:**
- Open Discover, a provider profile, the booking page, My bookings, both panel pages and the admin page at 1440px and at 375px; compare Discover side by side with the mockup.
