# Phase 7 — Strategy Planner prototype visual-parity report

**Verdict: the Phase 7 gate does NOT pass.** This revision supersedes the first
pass. It corrects that pass's central error, records what is now measured, and
states precisely what blocks the remaining gate criteria.

Nothing in this phase was pushed, merged, deployed, or flag-enabled.

- Base: `feat/strategy-proto-phase-6` @ `e102d1c9`
- Prior Phase 7 commit: `9e7126d7`
- Prototype reference: `Downloads\Capiro - Strategy Planner (PPBE) - standalone (2).html` (rendered, not recalled)
- Artifacts: `C:\dev\parity-p7\` (outside the repo — no binaries committed)

---

## 0. What changed since the first pass, and why it matters

The first pass reported "14 of 18 elements match to 0.00 CSS px". **Those
implementation measurements were taken against a mis-sized surface and are
withdrawn.**

antd's `<App>` renders a wrapper `<div>` between `#parity-root` and the
strategy surface. It defaults to `flex: 0 1 auto` with `min-height: auto`, so
it sized to **content** and `#parity-root`'s 846px region height never reached
the page. The measured chain was:

| element | height |
| --- | --- |
| `#parity-root` (the region) | **846** |
| antd `<App>` wrapper | **1288.04** ← unconstrained |
| `.sp-root` → page root → row | 1288.04 |
| `.sp-rail-in` (Meri panel) | **1157.75** |

Consequences, all of which corrupted the first pass's evidence:

- the Meri panel grew past the fold instead of scrolling internally;
- the composer sat at **y = 1210.29**, 310px below the visible region;
- the panel body never scrolled, so it reserved **no scrollbar** — which is the
  entire "P1 — Watch card list is 10px wider" finding (see §3);
- twelve implementation captures were taken of that surface.

Fixed in `apps/web/parity.html` by pinning `#parity-root > *` to
`height: 100%; min-height: 0`. After the fix the panel is **715.71px** ending
exactly at the region bottom (900) and the composer is pinned at y = 768.25.

**This is a harness fix, not a mask over a component defect** — the components
behave correctly once an ancestor bounds them. It does, however, point at a
real production gap; see finding **F1**.

Three fixture bugs were also found and fixed (§7).

---

## 1. Capture environment (plan §2)

| Setting | Value |
| --- | --- |
| Engine | Chromium (Chrome 150.0.7871.187) driven over CDP |
| Instance | dedicated, `--remote-debugging-port=9333`, own `--user-data-dir` |
| Viewport | 1440 × 900 CSS px, `deviceScaleFactor: 1`, zoom 100% |
| Appearance | light |
| Fonts | `document.fonts.ready` awaited on both sides |
| Prototype | `file://` — renders standalone, zero console errors |
| Implementation | the committed parity harness (`pnpm --filter @capiro/web parity`) |

---

## 2. Findings

### F1 — The Strategy editor is never bounded to the viewport (PRODUCT, pre-existing, live)

`theme.css` sets `html, body, #root { min-height: 100% }` and `.app-shell
{ min-height: 100vh }` — **`min-height`, not `height`** — and nothing
constrains the antd `<App>` wrapper or `.app-content`. The Strategy editor is a
full-height, internally-scrolling region (panel body scrolls, composer pinned,
Watch footer pinned), but no ancestor gives it a definite height, so it sizes
to content exactly as the harness did before the fix.

The codebase already contains the fix for this exact failure mode, applied to a
different page (`theme.css:1042`):

> "The Workspace editor is a full-height, self-contained app region: it owns
> its own internal scrolling … the 24px `.app-content` padding made the
> fixed-height shell overflow the viewport, **pushing the canvas bottom
> off-screen and breaking its internal scroll**."

There is a `.app-content:has(.ws-editor-shell)` rule and a
`.app-content:has(> .redesign)` rule. **There is no equivalent rule for the
Strategy page.**

`theme.css` and `strategy-ds.css` are byte-identical to `origin/main`, so this
is pre-existing and already live — **not introduced by Phases 4–7**. It is not
fixed here because it is a shell-level change outside this phase's scope and
outside the branch's blast radius. **Recommend a follow-up.**

### F2 — Panel placement diverges from the prototype (PARITY DEFECT)

Measured on both sides, same locator, panel closed then open:

| | prototype | implementation |
| --- | --- | --- |
| title width, panel **closed** | 1114 | 1114 ✓ |
| title width, panel **open** | **770** | **1114** ✗ |
| panel `y` | **54** (region top) | **184.29** (below the header) |
| panel height | **846** (full region) | 715.71 |

The prototype makes the Meri panel a **full-height right-hand column spanning
the whole content region**; the header lives in the left column and therefore
shrinks by exactly the 344px panel width when the panel opens. The
implementation puts the header across the full width and starts the panel
below it.

This is a visible structural difference and it changes where the title and goal
truncate. `Δw = +344.00` on both `headerTitle` and `headerEyebrow`.

### F3 — Header and today-flag line-heights differ (PARITY DEFECT)

Same font-size on both sides, different box height — the port does not set an
explicit line-height and inherits antd's 1.5714:

| element | prototype | implementation | Δh |
| --- | --- | --- | --- |
| `headerEyebrow` (10px) | 13.33 | 15.71 | +2.38 |
| `todayFlag` (10px) | 13.94 | 16.15 | +2.21 |
| header title `y` | 79.33 | 81.71 | +2.38 |

### F4 — Initial timeline scroll differs by 465.79px (LIA DECISION REQUIRED)

| | scrollLeft at 1440×900 |
| --- | --- |
| prototype | **837.33** |
| implementation | **371.54** |

The prototype's only scroll logic is
`scrollLeft = Math.max(0, mLeft(TODAY_M) - COLW * 1.5)` (`asset07` line 45).
The product deliberately replaced that; `timeline-scroll.ts`'s own header says
so:

> "the 'center today' decision can never silently depend on an arbitrary column
> count the way the previous mount-time approximation
> (`mLeft(TODAY_M) - COLW * 1.5`) did."

So the product centres today in the viewport and clamps. This is a deliberate,
unit-tested, **already-live** improvement over the prototype. Under plan §6
("no element displaced by more than 1 CSS px") every timeline element fails;
under plan rule 5 ("do not alter functional behavior merely to make one
screenshot pass") reverting it would be wrong. **Lia must choose.**

Measured attribution: forcing the implementation's grid to the prototype's
`scrollLeft` moves state 3's mismatch only **24.93% → 23.97%**, so the scroll
model is *not* the dominant contributor to the image-diff numbers (§5 is).

### F5 — States 12/13 are unsatisfiable as written (LIA DECISION REQUIRED)

Plan states 12 and 13 ask for "today before plan range, clamped left" and
"today after plan range, clamped right".

1. **The prototype cannot produce them** — it has no clamping of any kind.
2. **The product cannot produce them either.** `todayScrollLeft` does have
   `todayX < rangeStartX → 0` and `todayX > rangeEndX → maxScrollLeft`
   branches, but the call site passes the **rendered axis** range
   (`mLeft(OFF)` .. `mLeft(OFF + NMv)`), and `buildCalendar` always builds a
   3-fiscal-year axis anchored on today. Today is therefore always inside the
   range and **both branches are unreachable in production**. They are covered
   only by pure-function unit tests that pass numbers in directly
   (`timeline-scroll.test.ts:33,37`).

Related, and worth a follow-up on its own: **a plan lying entirely outside the
3-FY axis window renders no bars at all** (verified — `today-after`'s seven
nodes are all absent from the DOM). `timeline-scroll.ts` and `fiscal.ts` are
byte-identical to `origin/main`, so this too is pre-existing and live.

### F6 — Prototype-only content (accepted scope delta, unchanged from Phase 1/2)

A third **Meetings** layer chip and a "CLIENT MEETINGS RELATED TO THIS
STRATEGY" panel section; the third suggestion pill's wording. Carried forward,
not defects.

---

## 3. P1 from the first pass — RESOLVED, not a defect

The first pass flagged "Watch card list is 10px wider in the implementation
(298.67 vs 308.67)" as a candidate defect.

Cause: the prototype's panel body **scrolls** (`scrollHeight` 650 >
`clientHeight` 582) and so reserves a **10.33px scrollbar**, making every child
10px narrower. The implementation's panel body was not scrolling — because of
the unbounded surface in §0. After the harness fix, `watchCardList`,
`proposalCard`, `proposalTitle` and `whyExpansion` all match. **Closed.**

---

## 4. Geometry and computed-style audit (plan §5)

Both sides are measured by one script, `measure-v2.js`, and compared by
`compare2.py`.

The first pass's "locator artifacts" had a single root cause, now fixed: **the
prototype bundler renders off-canvas duplicate copies of the page** (elements at
x ≈ −579 and y ≈ 1052). "Smallest element containing the text" matched a hidden
duplicate, or the 12.5px shell breadcrumb instead of the 22px title. v2 scopes
every locator to the visible content region and to rendered elements, and emits
a per-key `_m` descriptor (tag, size, font-size, text) so **every row can be
audited rather than believed**. `compare2.py` reports `SUSPECT-LOCATOR` when the
two sides matched boxes more than 3× apart, instead of silently comparing them.

State 8 (Why expanded), 1440 × 900 — full table in
`strategy-prototype-visual-parity-phase-7-geometry.md`:

| verdict | count |
| --- | --- |
| PASS (Δw, Δh ≤ 1.00px) | **17** |
| FAIL | **4** (`headerTitle`, `headerEyebrow`, `todayFlag`, `grid`) |
| SUSPECT-LOCATOR | 1 |
| UNRESOLVED (absent one side) | 12 |

Passing at 0.00 px on both sides: every header control (`layerChipPpbe`,
`layerChipCongress`, `watchChip`, `exportBtn`, `historyBtn`), `headerGoal`,
`draftedNote`, and every Watch control (`acceptBtn`, `dismissBtn`, `whyBtn`,
`acceptAllBtn`, `pauseBtn`), plus the Watch card list and proposal card.

The 12 UNRESOLVED keys are states where the element is genuinely absent on one
side (e.g. the prototype shows chat and Watch simultaneously; the port's panel
shows one at a time). They are **not** passes.

---

## 5. Image comparison gate (plan §6) — BLOCKED, with measurements

Built `imgdiff.py`: pure standard library (`zlib` + `struct`), since the repo
has no image-diff facility, the plan forbids a new runtime dependency, and
neither Pillow nor numpy is installed. It decodes 8-bit PNGs, compares inside
the content region, and writes a 50% overlay and an absolute-difference image.
Validated: a self-diff reports 0.0000%.

| state | mismatch | largest blob | gate |
| --- | --- | --- | --- |
| 1 — list | 34.89% | 984 × 226 | FAIL |
| 3 — timeline, panel closed | 24.93% | 1156 × 705 | FAIL |
| 4 — panel open | 30.33% | 812 × 706 | FAIL |
| 8 — Why expanded | 32.30% | 812 × 706 | FAIL |

**These numbers must not be read as "the port is 25–35% wrong."** They are
dominated by **fixture divergence**, and plan §3's prerequisite — "fixtures that
produce the same visible content in both captures" — is not met:

- the legislative-calendar rows differ outright — in **dates, labels and row
  count**. The harness invents today-relative dates (`iso(-150)`…), so the port
  renders "MAR–FEB President's Budget", "APR–MAY Hearings", "JUN–JUL Committee
  markups" where the prototype renders "FEB President's Budget", "MAR–APR
  Hearings", "MAY–JUN Committee markups". The prototype also has a **"SEP
  Conference"** row the harness fixture does not, and names one row **"Floor &
  amendments"** where the harness says "Floor & conference";
- the two sides sit at different grid scroll offsets (F4), so different months
  and different nodes are on screen;
- state 1's remaining delta is real but small in kind: different setup-card
  **copy** (see §6), a black vs indigo primary button, and ~16px of extra
  vertical gap.

**The §6 gate cannot return a meaningful verdict until the reference-calendar
and node fixtures are made identical to the prototype's.** That is the single
highest-value next step, and it is not done.

---

## 6. Copy divergence (plan §6 "exact visible copy") — PRE-EXISTING

First-time-setup card, library page:

- prototype: "Your firm's annual operating rhythm anchors every strategy
  timeline. **We've pre-filled a standard 7-phase template — review and confirm
  it once. You can edit it anytime from any timeline.**"
- implementation: "… **Start from a standard 7-phase template, then adjust — it
  applies firm-wide and is editable anytime.**"

This branch's only change to `StrategyLibraryPage.tsx` is Phase 4's pending
watch-count nudge; the card is untouched Phase 1–3 code and is **already live**.
Not changed here — altering shipped product copy is Neo's or Lia's call.

---

## 7. Harness and fixture corrections made in this phase

| file | correction |
| --- | --- |
| `apps/web/parity.html` | pin `#parity-root > *` so the region height reaches the page (§0) |
| `src/parity/fixtures.ts` | `MEMBERS` keyed on `userId`; `memberName()` resolves by `clerkUserId`, so **every owner in the list rendered "Team member"** |
| `src/parity/fixtures.ts` | last row's `lastEditedAt` was `2027-01-24` — in the future, so it rendered "just now" instead of the prototype's "Jan 24"; now `2026-01-24T12:00Z` (midday, so it does not shift a day west of UTC) |
| `src/parity/state.ts`, `stubs/use-api.ts` | the library state now serves **no** firm phases, matching the prototype's default first-time-setup card; serving 6 phases rendered the shorter green "phases are set" bar and shifted every row below it |

Evidence-integrity note: the first pass's twelve captures contained only nine
distinct images (`04`/`05`/`07` and `12`/`13` byte-identical, and
`proto-03-timeline-panel-closed.png` was actually the list page). After the
fixes, `05` (long thread) is correctly distinct; `04`/`07` remain identical
because `state.ts` defines `watch` identically to `editor-panel`, and `12`/`13`
remain identical for the reason in F5.

---

## 8. Responsive and overflow gate (plan §2, §9) — PASS (implementation-only)

25 runs — 5 environments × 5 states — **0 failures**:

| environment | list | timeline closed | timeline panel | watch | long chat |
| --- | --- | --- | --- | --- | --- |
| 1440×900 @100% | ✓ | ✓ | ✓ | ✓ | ✓ |
| 1280×800 @100% | ✓ | ✓ | ✓ | ✓ | ✓ |
| 1920×1080 @100% | ✓ | ✓ | ✓ | ✓ | ✓ |
| 1440×900 @125% | ✓ | ✓ | ✓ | ✓ | ✓ |
| 1440×900 @150% | ✓ | ✓ | ✓ | ✓ | ✓ |

Asserted per run: `document.scrollWidth === clientWidth`; exactly one horizontal
scroller and it is `sp-timeline-grid-scroller`; title and goal stay one line;
the composer stays pinned inside the region; the Watch footer stays pinned; the
panel holds 344px; no unreachable content below the fold.

Two probe bugs were found and fixed before believing the result — the first run
reported 40 failures, **all artifacts**: the harness box was pinned to the
prototype's 1208px and overflowed any viewport narrower than 1440 (and any zoom
above 100%), and 2px of sub-pixel text overflow on a `<span>` was being counted
as a horizontal scroller.

**Caveat:** this passes *because* the harness now bounds the page height. Given
F1, production does not, so the composer-pinned and footer-pinned results here
do **not** currently describe production.

Raw results: `responsive-results.jsonl`; screenshots `resp-*.png`.

---

## 9. Not done

1. **Fixture parity for the timeline** (reference calendar + node placement) —
   the blocker for §6. Highest-value next step.
2. **Image-diff gate** — measured but not meaningful until (1).
3. **Prototype captures for states 5, 6, 9** — reachable in principle via
   interaction; not captured. States 10–13 are covered by F5.
4. **Interaction parity (§8)** — the 14-interaction matrix and the
   hover/focus-visible/disabled captures are **not started**.
5. **Correction loop (§7)** for F2 and F3.
6. `test/watch-chat-isolation.int-spec.ts` still self-skips without
   `DATABASE_URL` and has never run.

---

## 10. Required commands (plan §11)

Run from the repository root after the harness and fixture corrections:

| command | exit | result |
| --- | --- | --- |
| `pnpm --filter @capiro/web typecheck` | **0** | clean |
| `pnpm --filter @capiro/web test` | **0** | 154 files, **1330 passed / 1330** |
| `pnpm --filter @capiro/web build` | **0** | built in 34.72s; `dist/` contains **no** reference to the harness and no `dist/parity.html` |
| `pnpm --filter @capiro/api-strategy typecheck` | **0** | clean |
| `pnpm --filter @capiro/api-strategy test` | **0** | 56 passed / 4 skipped suites; **1210 passed / 17 skipped** |
| `pnpm --filter @capiro/api-strategy build` | **0** | clean |

Identical to the branch baseline recorded at the end of Phase 6 — this phase
changed only harness and documentation files, no product code.

---

## 11. Console / network errors

Prototype: none (one in-browser Babel transformer notice). Implementation: two
pre-existing app-wide React Router v7 future-flag warnings, no errors.

---

## 11. Reproduction

```bash
# 1. dedicated Chrome
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9333 --user-data-dir="C:\dev\.chrome-p7" --no-first-run

# 2. the implementation harness
pnpm --filter @capiro/web parity        # http://127.0.0.1:5199/parity.html?state=…

# 3. captures, measurements, diffs, responsive matrix
cd C:\dev\parity-p7
bash capture-impl.sh 5199 1440 900 -v3
node cdp.mjs --url "file:///C:/Users/neoma/Downloads/Capiro%20-%20Strategy%20Planner%20(PPBE)%20-%20standalone%20(2).html" \
  --width 1440 --height 900 --settle 2500 --act acts/proto-why.json \
  --eval measure-v2.js --shot proto-08-v2.png > proto-08-v2.txt
python compare2.py proto-08-v2.txt impl-08-v3.txt compare2-08-v3.md "state 8"
python imgdiff.py proto-08-watch-why.png impl-08-watch-why-v3.png diff-08-why --box 232,54,1208,846
bash run-responsive.sh 5199
```

`capture-impl.sh` replaces `capture-impl.ps1`: this machine's PowerShell
execution policy refuses unsigned `.ps1`.
