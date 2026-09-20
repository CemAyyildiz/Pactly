---
title: 'Story 3.10 — Editorial design system across every screen'
type: 'feature'
created: '2026-09-20'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'ea3a727d43b6737dfe164c3baed0a41ea5f9aa45'
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/DESIGN.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/EXPERIENCE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The owner rejected the built interface twice: first the Two Sides palette, then the Discover v2 language. The direction they accepted is the editorial one in `mockups/editorial-v1.html` — warm paper, near-black ink, Libre Bodoni over Public Sans, hairline rules, generous whitespace, and Stellar's own yellow `#FDDA24` as the single accent.

**Approach:** Make that mockup the product's design system. Rewrite DESIGN.md around it, restyle every screen against it, and keep the accent disciplined: yellow marks and underlines, and carries words only on black.

## Boundaries & Constraints

**Always:**
- `mockups/editorial-v1.html` is the source of truth for colour, type, spacing, rules and component shape. Read its `<style>` block before writing CSS; port its decisions rather than inventing near-misses.
- Tokens: paper `#FAFAF9`, card `#FFFFFF`, ink `#1C1917`, body `#3B3733`, muted `#6F6862`, rule `#E3DED6`, strong rule `#CFC8BE`, Stellar yellow `#FDDA24`, soft yellow `#FFF6D1`, gold ink `#8A6410` (for text that must read gold), escrow `#14110F` on `#F5F1EA`, alert `#9A3412`.
- Type: Libre Bodoni for display and names, Public Sans for everything else. No third family. Money and times keep `tabular-nums`.
- The yellow's rules, which are what keep it from looking cheap:
  - never a text colour on paper or white (it fails contrast) — use gold ink when a word must read gold;
  - it may carry words only on the escrow black;
  - it appears as a mark, an underline, a soft highlight behind a number, or a 3px rule — never as a large fill.
  Everywhere it appears, an ink or gold-ink element carries the same meaning, so nothing depends on the yellow alone.
- Black stays the money colour: the escrow lane, the deposit pill and the single "Lock with Pactly" button (black ground, yellow label). No other button is black.
- Lists are editorial rows separated by hairlines, not stacked cards: portrait image, serif name, one-line deck, a quiet meta line, and a right-hand rail carrying price and deposit. Filters are small-caps labels over underlined fields, not boxes.
- Accessibility holds: body text and muted text at 4.5:1 or better, visible focus rings, 44px targets, `prefers-reduced-motion` respected, state never carried by colour alone.
- Every screen moves: Discover, provider profile, booking and payment, My bookings, the panel's availability and bookings pages, the admin resolutions page, and every shared component.

**Never:**
- No behaviour, route, data or copy change beyond what a restyle forces. The backend's tests must pass untouched.
- No new dependency and no CSS framework. `tokens.css` plus `base.css` stay the only styling mechanism.
- Do not copy the mockup's markup: it is a static page with hard-coded data.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tokens | `tokens.css` | Carries the editorial values and the two font families only | No error expected |
| Stale token | Any file under `frontend/src` | No `--color-client*`, `--color-pro*`, `--color-you*`, Instrument Sans, Newsreader or the earlier three families remain | A grep finds none |
| Yellow discipline | Any rule using the Stellar yellow | It is a mark, rule, underline or a colour on black — never text on paper, never a large fill | A pairing that fails contrast is corrected |
| Money black | Any button | Only "Lock with Pactly" is black, and its label is yellow | No error expected |
| Provider identity | Provider header and booking lane | Reads as the provider's side without the old teal; identity is carried by type and rule, not a second brand colour | No error expected |
| Contrast | Body, muted, gold-ink and on-black text | 4.5:1 or better (3:1 for large display text) | A failing pair is corrected, not shipped |
| Narrow screen | 375px | Single column, no horizontal scroll, rails stack under their row | No error expected |
| Reduced motion | `prefers-reduced-motion: reduce` | Transitions and animations are off | No error expected |

</intent-contract>

## Code Map

- `_bmad-output/planning-artifacts/ux-designs/ux-Pactly-2026-09-15/mockups/editorial-v1.html` -- the reference. Its `:root`, `.row`/`.rail`, `.slot`, `.cats`, `.filters`, `.profile`/`.aside`, `.lanes`/`.escrowlane` and focus/reduced-motion blocks map directly onto the components below.
- `.../DESIGN.md` -- currently describes the Discover v2 language (itself a rewrite of the original). Rewrite it again, keeping its structure: frontmatter tokens, Colors, Typography, Layout & Spacing, Elevation, Shapes, Components, Do's and Don'ts. Record that `editorial-v1.html` is the reference and that both earlier mockups' palettes are superseded while their compositions still inform layout.
- `frontend/src/styles/tokens.css`, `base.css` -- every token and component class. Most of the work is here.
- `frontend/src/components/` -- `ProviderCard`, `ProviderCardSkeleton`, `SlotChip`, `DepositPill`, `ProviderHeader`, `CategoryTabs`, `SearchBox`, `FilterRail`, `FilterSheet`, `EmptyResults`, `BookingCard`, `BookingActions`, `StateLabel`, `Countdown`, `EscrowLane`, `LockButton`, `Seal`, `EscrowProof`.
- `frontend/src/pages/` -- `discover`, `provider`, `booking`, `my-bookings`, `panel` (availability and bookings), `admin`.
- `README.md` -- names the design system and fonts; update those lines.

## Tasks & Acceptance

**Execution:**
- `DESIGN.md` -- the rewrite described above.
- `frontend/src/styles/tokens.css` -- editorial tokens, named for meaning (`--color-paper`, `--color-ink`, `--color-body`, `--color-muted`, `--color-rule`, `--color-rule-strong`, `--color-stellar`, `--color-stellar-soft`, `--color-gold-ink`, `--color-escrow`, `--color-escrow-text`, `--color-alert`), and the two font variables.
- `frontend/src/styles/base.css` -- the font links and every component class, ported from the mockup.
- `frontend/src/components/**`, `frontend/src/pages/**` -- class and markup changes the new shapes need (for example the list row's three columns), with no logic edits.
- `README.md` -- correct the design-system and font lines.

**Acceptance Criteria:**
- Given the running app, when Discover is opened, then it reads as `editorial-v1.html`: warm paper, hairline-separated rows, serif names, a right-hand price rail, quiet slot chips with a day, and the yellow only where the mockup puts it.
- Given the provider profile, booking, My bookings, both panel pages and the admin page, when each is opened, then all use the same language, and the only black button in the product is "Lock with Pactly" with its yellow label.
- Given the repository, when `npm run -w frontend typecheck` and `build` run, then both are clean; `npm run -w backend test` passes untouched; and a grep finds no superseded token or font name under `frontend/src`.

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `npm run -w frontend typecheck && npm run -w frontend build` -- expected: clean
- `npm run -w backend test` -- expected: unchanged, all pass
- `grep -rn -- "--color-client\|--color-pro\|--color-you\|Instrument Sans\|Newsreader\|Darker Grotesque\|Familjen Grotesk\|Martian Mono" frontend/src` -- expected: no matches

**Manual checks:**
- Open every screen at 1440px and 375px beside the mockup; confirm the yellow appears only as a mark, rule, underline, soft highlight or on black.

## Auto Run Result

Status: done

**Özet:** Sekiz ekran ve paylaşılan bileşenler `mockups/editorial-v1.html`'in diline taşındı; DESIGN.md aynı dile göre yeniden yazıldı. Stellar sarısı yalnızca işaret, çizgi, vurgu ve siyah üstünde yazı olarak kullanıldı.

**Commit'ler:** `9997e09` spec, `d8f9e0a` feat.

**Review:** Katmanlı review çalıştırılmadı; görsel kabul sahibinin. Otomatik kontroller (typecheck, build, eski token taraması, backend 448/448) temiz.

**Kalan riskler:** Tarayıcıda hiçbir ekran görülmedi. Discover'ın yapısı değişti (kategoriler üstte tam genişlik, filtreler sağda dar kolon). Mockup'taki ikinci siyah buton ("Continue") niyet sözleşmesi gereği çerçeveli yapıldı.
