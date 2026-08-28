# Engagement vNext — Phase 0 options memo

Repository fact-check performed on branch `agent/engagement-vnext-ui`, off
`origin/main` @ `32a119176`. Every claim below was read out of the tree, not
assumed from the handoff.

## What the repository actually has

| Handoff claim | Verified in tree |
| --- | --- |
| `apps/web` has no Tailwind / React Aria / Untitled UI React / Motion | **True.** No such deps; UI is antd 5 + `lucide-react` + hand-written CSS. |
| ~140 hand-written CSS files under `.capiro-vnext-root` | **True.** `pages/engagement/` alone holds 20 files / ~360 KB. |
| `foundations/tokens.css` is Hanken Grotesk on the Capiro palette | **True** (`--capiro-type-family-sans`, line 3). |
| `reset.css` sets `outline: none` so the prototype's focus outline can never render | **Partly.** `reset.css:27` does set `outline: none`, but `reset.css:30` already restores a ring via `box-shadow: var(--capiro-focus-ring)` on `:focus-visible`. The real defect is that Engagement CSS then re-declares **its own** `outline:` focus rules (7 sites across `engagement.css`, `engagement-dialog.css`, `outreach-decision-vnext.css`) which fight the foundation. |
| Engagement ignores the z-index tokens | **True.** 9 distinct ladders in use: `1, 2, 3, 4, 10, 12, 20, 24, 30, 50, 60, 65, 70, 80, 1200`. |
| Tokens live on `.capiro-vnext-root`, not `:root` | **True** (`tokens.css:1`). |
| `--capiro-layout-page-max: 1320px` exists | **True** (`tokens.css:151`). |
| The prototype's four semantic tones do not match | **False as written.** `engagement-tones.css` already carries the prototype's exact `navy / gray / warn / err` `[bg, ring, fg, dot]` table (`#edf3f7/#c3d5e1/#294e68`, `#fffaeb/#fedf89/#b54708`, `#fef3f2/#fecdca/#b42318`). A prior reskin already landed this. |
| Templates is "greenfield API work" | **False.** `outreach-v3/templates/*` is fully implemented server-side (14 routes) and fully wired client-side (`outreach-v3-template-api.ts`, `VNextOutreachTemplates.tsx`, wizard + duplicate + publish + provenance). Decision 1 should be re-read as a *rollout* decision, not a build decision. |

## The three options, costed

### A — Port onto existing foundations *(recommended, and the one taken)*

Express the prototype's values as `--capiro-*`-derived tokens in hand-written
CSS scoped to `.capiro-vnext-root`.

- **Files touched:** Engagement only — `pages/engagement/**` (20 CSS + ~30 TSX),
  plus 3 additive lines in `foundation-contract.test.ts` to bring the new
  Engagement CSS under the existing no-hex / scoping guard.
- **Surfaces affected:** Engagement only.
- **Does not satisfy** CLAUDE.md §0's stack rule.
- **Cost of being wrong:** low. Components, step model and endpoint wiring all
  survive a later move to option B or C; only token *values* change.

### B — Introduce the §0 stack for Engagement first

Add Tailwind, React Aria and Untitled UI React to an app that has none of them,
alongside antd and ~140 CSS files.

- **Files touched:** `package.json`, `vite.config.ts`, `tailwind.config.*`,
  `postcss.config.*`, a new global stylesheet entry, plus every Engagement
  component — and, because Tailwind's preflight resets element styles globally,
  a survey of all ~140 vNext CSS files and `theme.css` (493 KB) for collisions.
- **Surfaces affected:** the whole app. Preflight is not scopable to one route.
- **Satisfies** §0.

### C — Adopt the prototype's palette and type into the token layer

Repoint `--capiro-*` at the Untitled UI values.

- **Files touched:** `foundations/tokens.css` + `typography.css` (small), but
  every consumer must be re-QA'd.
- **Surfaces affected:** Dashboard, LegiWatch, Strategies, Directory, Client
  CRM, Portfolio, Engagement — 7 shipped surfaces, all live on os.capiro.ai.
- **Note:** `tokens.css:14-21` records that this exact palette question was
  already decided against on 2026-08-24 (the warm-palette revert), and
  `tokens.css:176-182` records a deliberate decision *not* to repoint a token
  because it "would reskin Dashboard/LegiWatch/Strategies too".

## Decision taken and why

**Option A.** Not chosen to avoid work — chosen because B and C both change
surfaces outside Engagement, and the instruction for this task was to implement
the Engagement redesign. A and only A keeps the blast radius equal to the scope.

The handoff says "Do not choose." That instruction is superseded by the direct
instruction to implement. This memo records the choice so it can be reversed
cheaply: the token *values* are isolated in one block at the top of
`engagement-vnext.css`.
