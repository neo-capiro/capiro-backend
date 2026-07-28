# Phase 7 — Strategy Planner prototype visual-parity report

**Verdict: the Phase 7 gate does NOT pass yet.** The capture and measurement
infrastructure is built and working, 12 implementation states and 4 prototype
states are captured reproducibly, and 14 of the 18 elements measurable on both
sides match to **0.00 CSS px**. The remaining evidence the gate requires — a
verified geometry table for every element, image diffs, the responsive matrix,
and the interaction pass — is not complete. Details and exact gaps below.

Nothing in this phase was pushed, merged, deployed, or flag-enabled.

- Base: `feat/strategy-proto-phase-6` @ `e102d1c9` (Phases 1–5 merged onto `main` @ `1cdd372f` in Phase 6)
- Head: this phase's commit on the same branch
- Prototype reference: `Downloads\Capiro - Strategy Planner (PPBE) - standalone (2).html` (rendered, not recalled)
- Artifacts: `C:\dev\parity-p7\` (outside the repo — no binaries committed)

---

## 1. Capture environment (plan §2)

| Setting | Value |
| --- | --- |
| Engine | Chromium (Chrome 150.0.7871.187) driven over CDP |
| Instance | dedicated, `--remote-debugging-port=9333`, own `--user-data-dir` |
| Viewport | 1440 × 900 CSS px, `deviceScaleFactor: 1`, zoom 100% |
| Appearance | light |
| Fonts | `document.fonts.ready` awaited on both sides; identical families/weights |
| Prototype | `file://` — renders standalone, 7 font faces loaded, zero console errors |
| Implementation | the parity harness (§2) |

Both sides are driven by the same zero-dependency CDP script
(`C:\dev\parity-p7\cdp.mjs`, inherited from the Phase 1/2 toolkit and extended
here with `--act`, `--zoom` and console/exception capture).

## 2. How the implementation is rendered (plan §1, §3)

The repository has **no browser/E2E harness** (no Playwright, no Cypress —
confirmed again this phase), and the plan allows "the available browser-control
tooling and a deterministic screenshot script without adding a product
dependency". Phases 1–2 evidently did the same thing with a throwaway page; this
phase makes it reproducible and commits it:

- `apps/web/parity.html` + `apps/web/vite.parity.config.ts` + `apps/web/src/parity/*`
- run with `pnpm --filter @capiro/web parity` (dev-only; `vite build` never sees it)

What is production in that harness: the real `StrategyLibraryPage` /
`StrategyEditorPage` and everything they mount (header, timeline, Meri panel,
Watch panel, chat thread, composer), the real `api.ts` hooks and query cache, the
real `strategy-ds.css`/`theme.css`, and the real antd theme — now shared from
`src/theme-antd.ts` by both `main.tsx` and the harness so the two cannot drift.

What is stubbed: **only** the axios transport (`lib/use-api.ts`) and
`@clerk/clerk-react`. Every state is reached by driving the real UI (clicking
*Ask Meri*, deep-linking `?node=`, clicking *Why?*, clicking *Accept* against a
deliberately hung request) — no component takes a harness-only prop.

The harness renders the strategy surface into the prototype's own content-region
box — **x=232, y=54, 1208 × 846**, measured from the prototype (232px sider,
54px topbar) — so the compared region aligns without reproducing the app shell,
whose parity is not part of this rollout.

Fixture content is the prototype's own: `WATCH_PROPOSALS` (all five, verbatim),
the library rows, the editor eyebrow/title/goal, the firm-phase labels and the
legislative-calendar rows, all read out of the prototype bundle's decompressed
source rather than invented.

## 3. Captures produced

### Prototype (`C:\dev\parity-p7\proto-*.png`)

| # | State | File |
| --- | --- | --- |
| 1 | Strategy list — default (also carries the "5 proposed changes to review" row, state 2) | `proto-01-list-default.png` |
| 3 | Timeline — panel closed | `proto-03-editor.png` |
| 4 | Timeline — Meri panel open (Watch proposals visible = state 7) | `proto-04-panel-strategy.png` |
| 8 | Timeline — Why expanded | `proto-08-watch-why.png` |

### Implementation (`C:\dev\parity-p7\impl-*.png`, all 12 states)

`impl-01-list`, `impl-03-editor-closed`, `impl-04-panel-strategy`,
`impl-05-panel-long`, `impl-06-panel-step`, `impl-07-watch`,
`impl-08-watch-why`, `impl-09-watch-rechecking`, `impl-10-low-context`,
`impl-11-truncation`, `impl-12-today-before`, `impl-13-today-after`.

Reproduce with `powershell -File capture-impl.ps1 -Port <vite port>`.

## 4. Geometry and computed-style audit (plan §5)

Both sides measured with ONE script (`measure-both.js`) that locates elements by
their own visible text on both sides — the same locator strategy, not two
hand-tuned selector sets. Full table: `compare-08-watch-why.md`.

**Result: 14 of 18 elements measurable on both sides match exactly (Δw = Δh = 0.00 px):**

| element | prototype | implementation |
| --- | --- | --- |
| PPBE layer chip | 63.85 × 26 | 63.85 × 26 |
| Congress layer chip | 86.06 × 26 | 86.06 × 26 |
| Watch chip | 110.43 × 26.67 | 110.43 × 26.67 |
| Export button | 84.43 × 34 | 84.43 × 34 |
| History button | 87.24 × 34 | 87.24 × 34 |
| Meri panel (rect) | 343.33 × … | 343.33 × … |
| composer box | 315.33 × 48.67 | 315.33 × 48.67 |
| composer input | 199.67 × 17.5 | 199.67 × 17.5 |
| suggestion pill | 151.48 × 24.67 | 151.48 × 24.67 |
| Accept | 60.57 × 26.67 | 60.57 × 26.67 |
| Dismiss | 55.39 × 24.67 | 55.39 × 24.67 |
| Why? | 25.79 × 13.33 | 25.79 × 13.33 |
| Accept all N | 75.13 × 24.67 | 75.13 × 24.67 |
| Pause for this strategy | 122.5 × 24.67 | 122.5 × 24.67 |

Also verified directly:

- **No document-level horizontal overflow on either side** at 1440 × 900
  (`scrollWidth === clientWidth === 1440` for both).
- Watch card list `max-height: 372px` on both.
- Implementation header height **130.29 px** (Phase 1's measured prototype value
  was 129; the phase budget is ≤132).
- `btnPrimary` is byte-identical between the prototype source and
  `strategy-ui.tsx` (`background: var(--ink-1)`), so the dark Accept button is
  correct and not a token drift — checked because it *looked* wrong.
- The prototype's fractional rects (26.67 where `offsetWidth` reads 26) are
  ordinary sub-pixel text layout, not a zoom/transform: the whole ancestor chain
  reports `zoom: 1`, `transform: none`, and the rect/offset ratio is 1.005.

### Findings

**P1 — candidate real difference: Watch card-list content width is 10 px wider
in the implementation** (prototype 298.67 px, implementation 308.67 px; heights
identical at 372). The port DOES carry the prototype's
`::-webkit-scrollbar{width:10px}` rule (`strategy-ds.css:120`), so the cause is
more likely a padding/margin difference in the chain between the 344 px panel and
the card list. Not yet confirmed either way — it needs one more measurement pass
over both padding chains, and is recorded as a candidate rather than asserted as
a defect or dismissed.

**Four table rows are locator artifacts, not defects** — the shared
locator matched a different element on the prototype side and the comparison is
therefore invalid, not failing:

- `header` — matched `<body>` on the prototype (its header does not nest LAYERS
  and Export under one node the way the port does).
- `headerEyebrow`, `headerTitle` — the prototype repeats the strategy title in
  the shell breadcrumb, and the "smallest element containing the text" rule
  picked the breadcrumb (font-size 12.5 px, i.e. not the 22 px title).
- `panel` computed `width` (343.333 vs 315.333) — the ancestor walk landed on
  different nodes; the panel *rects* match exactly.

## 5. What the gate still requires (not done)

1. **Per-side locator verification** for the ~25 keys reported UNVERIFIED in
   `compare-08-watch-why.md` (goal line + tooltip, drafted note, user/Meri
   bubbles, attachment chip, proposal card and badge, Why expansion, frozen
   label column, today flag, needs-context marker, …). Every one is a real
   element on both sides; the shared text locator simply does not resolve it on
   one side yet. Until they are measured they are **not** passes.
2. **Image comparison gate (§6)** — overlays, absolute-difference images and
   mismatch percentages for every primary state. Not started. Note the two sides
   are only diffable inside the content-region rect, which is why the harness
   pins that box.
3. **Prototype captures for states 5, 6, 9–13** — the prototype's fixture drives
   states 5/6/9 through interaction (long thread, step thread, Re-checking), but
   states 10–13 (low context, truncation, today clamped left/right) appear to
   have **no reachable prototype state at all**, which is the same wall Phases 4
   and 5 hit. If that is confirmed, those four rows can never have a prototype
   half and the plan's requirement is unsatisfiable as written — a
   `LIA DECISION REQUIRED` in the making rather than an implementation gap.
4. **Responsive matrix (§2/§9)** — 1280 × 800, 1920 × 1080, and 1440 × 900 at
   125% / 150% for five states. Not started; `cdp.mjs --zoom` is wired for it.
5. **Interaction parity (§8)** and the hover/focus-visible/disabled captures.
6. **Correction loop (§7)** for anything the above surfaces.

## 6. Known prototype-vs-product scope deltas (not defects)

These are prototype-only features that the product deliberately does not have,
carried forward from Phase 1/2 and visible in any side-by-side:

- a third **Meetings** layer chip, and a "CLIENT MEETINGS RELATED TO THIS
  STRATEGY" section in the panel;
- the third suggestion pill reads "Push markup defense" in the prototype and
  "Push the latest action a quarter" in the product, because the prototype's pill
  names a step that only exists in its own fixture (Phase 2 decision).

## 7. Console / network errors

Prototype: none. Implementation harness: two React Router v7 future-flag
warnings (pre-existing, app-wide) and no errors. Captured automatically by
`cdp.mjs` (`=== CONSOLE ===`).

## 8. Reproduction

```powershell
# 1. dedicated Chrome
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9333 --user-data-dir="C:\dev\.chrome-p7" --no-first-run

# 2. the implementation harness
pnpm --filter @capiro/web parity     # http://127.0.0.1:5199/parity.html?state=…

# 3. captures + measurements
cd C:\dev\parity-p7
powershell -File capture-impl.ps1 -Port 5199
node cdp.mjs --url "file:///C:/Users/neoma/Downloads/Capiro%20-%20Strategy%20Planner%20(PPBE)%20-%20standalone%20(2).html" `
  --width 1440 --height 900 --settle 2500 --act acts\proto-why.json `
  --eval measure-both.js --shot proto-08-watch-why.png
python compare.py proto-08-measure.txt impl-08-measure.txt compare-08-watch-why.md
```
