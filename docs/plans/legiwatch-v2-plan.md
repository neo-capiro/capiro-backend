# LegiWatch v2 — Implementation Plan

Source inputs (Downloads): **LegiWatch Requirements (Gherkin).md**, **LegiWatch Feature Spec.html**,
**LegiWatch-Prototype-standalone.html** (unpacked to per-screen React modules and read in full).
Prepared 2026-07-05. Pairs with `project_radar_cutover` / `project_radar_followups` memory.

---

## 0. Framing — read this first

**LegiWatch is the shipped Radar feature, renamed and refined to the prototype's "v2 calm design."**
The spec/Gherkin were authored around the same idea Radar already implements (unify Bill Tracker +
Hearing Watch behind one watchlist → one feed). Radar (PRs #231/#233/#236/#238/#242, live in prod on
all 4 tenants) already delivers the **model, IA, most flows, and the backend**. This plan is a **delta**:
rename + a UX-v2 redesign pass + first-run orientation + a client-profile **Saved** subview and the one
genuinely-new backend piece (**Save Recap → client profile + Meri knowledge**).

The spec's own **non-goal** holds and bounds scope: *no* re-engineering of the transcription pipeline,
recommender scoring, or change-detection classification. This is "where things live, how they connect,
the first-run experience, and the calm redesign."

Several of the spec's "open questions" are **already resolved by the shipped build** — see §6.

---

## 1. What already exists (verified against the codebase, not assumed)

| Spec/Gherkin requirement | Status today | Where |
|---|---|---|
| One destination, 4 tabs (Feed/Bills/Hearings/Watchlist) | **Exists** as `/radar` | `apps/web/src/pages/radar/RadarPage.tsx` |
| First item under Intelligence nav | **Exists** (Radar is first child) | `apps/web/src/components/AppShell.tsx:141` |
| Shared components across standalone + client profile | **Exists** — RadarPage composes `TrackerSurface`, `TrackerFeedPanel`, `HearingWatchPanel`, `BillDrawer` | `RadarPage.tsx:14-17` |
| Client-profile embedded tab | **Exists**, labeled "Radar", renders `TrackerTab` | `apps/web/src/pages/clients/ClientProfilePage.tsx:452,526` |
| Unified watchlist model (issue areas + typed tags, priority/position/tuning) | **Exists** (P5) — retired raw-UUID entry | `apps/web/src/pages/clients/tracker/TrackerConfigPanel.tsx` (priority/position cycle pills at :172-199) |
| First-run cold-start guided empty state | **Exists** (P6) — `isColdStart`, single CTA → Watchlist | `RadarPage.tsx:101-122` |
| Bill side drawer, never routes to Data Explorer | **Exists** (P7) | `apps/web/src/pages/radar/BillDrawer.tsx` |
| Bill ↔ hearing interlink (both directions) | **Exists** (P9) | `bill-hearings-api.ts`, `BillDrawer.tsx` |
| Feed hand-offs: Draft memo→Workspace, Send outreach→wizard, Add-to-report | **Exists** (P10) | `apps/web/src/pages/clients/tracker/alert-actions-api.ts`, `TrackerFeedPanel.tsx` |
| Global (all-clients) Feed roll-up, keyset-paginated | **Exists** (P11) | `TrackerFeedPanel.tsx`, `intel-feed-api.ts` |
| One-click hearing stream resolver + consent-only-for-private | **Exists** (P8) | `apps/intel-api/src/hearing/stream-resolver.service.ts`, `hearing-session.service.ts` |
| Per-user alert prefs ("Your alerts for [client]"), SMS "coming soon" | **Exists** (P1.3/D13) | `TrackerConfigPanel.tsx` |
| Hearing brief generation (raw material for a recap) | **Partial** — assembles exec summary from session data; **no KB write, no persistence** | `apps/intel-api/src/hearing/hearing-brief.service.ts` |
| Client-profile **Saved** recap subview | **Missing** | — |
| Save Recap → persist to client + write to Meri knowledge | **Missing** (new backend) | — |
| First-run **orientation intro** + "How it works" control | **Missing** | — |
| Calm v2 Feed cards (collapse/expand, one severity cue, tag chip) | **Partial** — feed exists; card treatment is not the v2 "calm" design | `TrackerFeedPanel.tsx` |
| Hearings labels: "Watch live"/"Watch recording", "My Sessions", watched→open | **Missing** — button is plain "Watch"; sub-view is "sessions" not "My Sessions" | `apps/web/src/pages/intelligence/HearingWatchPage.tsx:140,150-177` |
| Name = "LegiWatch" everywhere | **Missing** — everything says "Radar" / "Hearing Watch" | nav, routes, page titles, profile tab |

**Bottom line:** the machine is built and live. The delta is a **rename + a calm-UI redesign pass + orientation + the Saved/Save-Recap-to-KB feature.**

---

## 2. The genuine delta (grouped)

- **G1 — Rename** Radar → LegiWatch; "Watchlist" tab → "Configure"; client-profile "Radar" tab → "LegiWatch". Route `/radar` → `/legiwatch` (keep `/radar` as a redirect for live alert-email deep-links).
- **G2 — Feed v2 (calm cards):** collapsed = title · client text-label · matched **tag chip** · date + one primary action + chevron; **one** severity cue (colored left edge only — no filled badge+word); expand reveals evidence (bill status / hearing quotes with "+N more") + full action set. Remove any "matches tag…" sentence and "why it matters" pill. Right rail: **Show** (source filter incl. Bill+Hearing) · **Arrange** (single stream default / group-by-client) · **At a glance** (severity counts). States: loading skeletons / plain empty / populated.
- **G3 — Bills v2:** "**Recommended by Meri**" section **always** above the board (Fit score, bill#, title, reason, sponsor; **Track** / "On your board" inline; below-floor expander). Board = **read-only** live-status mirror (no drag; membership via track/untrack; filter All/Priority-tag/High-prob≥70%; sort). All-clients board = per-client-labelled roll-up. "Add bill" search modal. "in N hearings" chip.
- **G4 — Hearings v2:** default = **All hearings** (Upcoming/Archive segmented) + **My Sessions** sub-view. Action label **Watch live** (upcoming/live) vs **Watch recording** (archive); watched archive → "open saved session." One-click ingest modal with auto-resolve states (**resolving → resolved / fallback**); manual entry only as **"Add hearing manually"** fallback link (no competing standing button). Consent step only for private sources. My Sessions rows: plain labels ("N watchlist matches", live/ended, "recap saved") — remove the undefined "moments" label. Room states: disconnected / authorizing (private) / live / ended.
- **G5 — Configure v2:** rename tab; in-context client selector; issue-area toggles autosave; each tag shows **priority** (High/Med/Low — drives ranking) + **position** (Support/Oppose/Monitor — stance) with inline explanation; expandable term editor; import-from-profile for cold clients; "Your alerts for [client]" (per-user), email live, SMS "coming soon." *(Most of this exists — this is copy/inline-explanation + layout polish.)*
- **G6 — Orientation:** one-time, plain-language 4-step intro on first run, dismissable, does not reappear; a permanent **"How it works"** control in the top bar reopens it.
- **G7 — Client-profile LegiWatch tab:** rename; sub-tabs **Feed · Bills · Hearings · Saved**; a **watchlist STATUS strip** with "Edit in LegiWatch" link (never a second editor); reuse the same components/density.
- **G8 — Save Recap → client Documents + Meri knowledge (DECIDED):** post-session "Save recap" → generate the recap **using the existing `hearing-brief` output** (decision #3 — no new generator) → "Save to Client Profile" (a) creates a **client-scoped document in the client profile's Documents section** — the *same* store that "Draft memo → Save to Documents" already writes to — and (b) writes it into the client's **Meri knowledge** base. **No new `IntelSavedRecap` table.** The client-profile LegiWatch **"Saved"** sub-tab renders that client's recap documents (filtered from Documents), each linking back to its source session.
- **G9 — Altitude/copy (U1):** default **All clients** across Feed/Bills/Hearings; the client filter narrows the whole feature and persists across tabs; scoping to a **cold** client shows the single guided CTA, never a blocking gate; **Configure** is the only client-required surface.

---

## 3. Phased implementation (each phase is shippable + adversarially reviewed before deploy)

Ordering favors low-risk rename first, then per-tab redesign, then the new backend last so it lands on a
stable surface. Every phase carries the established bar: per-branch review → integrated-tree review →
CI green → deploy → live smoke. Reuse feature flags `tracker_v2` / `hearing_watch` (no new flag needed;
see §5).

**L0 — Rename & route (G1, G9 defaults).**
Nav label + icon, `/legiwatch` route with `/radar`→`/legiwatch` redirect (preserve `?tab`/`?client`),
page title/heading, "Watchlist"→"Configure" tab, client-profile tab label. Confirm the client filter
persists across tabs and defaults to All-clients. *Files:* `AppShell.tsx`, `App.tsx`, `RadarPage.tsx`,
`ClientProfilePage.tsx`. *Accepts:* Gherkin "Navigation & altitude", "Tabs are Feed/Bills/Hearings/Configure".

**L1 — Feed v2 calm cards (G2).**
Rework `TrackerFeedPanel` card into collapse/expand with one severity cue, tag chip, client text-label,
"+N more" quotes, rail (Show/Arrange/At-a-glance). *Accepts:* Gherkin "Feed", "Feed alert actions",
"Feed states".

**L2 — Bills v2 (G3).**
Recommendations-always-visible Meri section; read-only board polish; filters/sort; all-clients roll-up;
"in N hearings" chip; Add-bill modal. *Accepts:* Gherkin "Bills".

**L3 — Hearings v2 (G4).**
Relabel Watch live/recording; rename sub-view "My Sessions"; watched→open; auto-resolve modal states +
manual fallback link; trimmed session labels. *Accepts:* Gherkin "Hearings", "Live hearing room states".

**L4 — Configure v2 (G5).**
Inline priority/position explanation, layout polish, "Your alerts for [client]" copy, import-from-profile
prominence. *Accepts:* Gherkin "Configure (watchlist)".

**L5 — Orientation (G6).**
First-run intro modal (4-step), per-user "seen" persistence (see §4), "How it works" top-bar control.
*Accepts:* Gherkin "Orientation".

**L6 — Client-profile Saved + Save Recap → Documents + Meri knowledge (G7, G8) — the new backend.**
Post-session "Save recap": generate via the existing `hearing-brief` output (decision #3), then persist as
a **client Document** (reuse the Documents/Workspace store that "Save to Documents" already targets) **and**
write to the client's Meri knowledge. Add the profile **Saved** sub-tab (a filtered view of recap documents,
each linking to its source session) + the watchlist-status strip. **No new recap table.** Draft-memo
formatting is **unchanged** (decision #4). *Accepts:* Gherkin "Post-session actions", "Client profile —
LegiWatch tab" (Saved).

**L7 — Integrated review + ship.**
Full adversarial review of the merged tree (the classes that only appear when phases combine:
rename/redirect gaps, client-scope leakage across tabs, KB-write tenant isolation), CI, deploy web +
intel-api, live smoke on a real client.

---

## 4. Data model & backend changes (L6) — reduced by decisions #2/#3

1. **No new recap table.** Recaps are saved as **client Documents** (reuse the existing Documents/Workspace
   store that "Draft memo → Save to Documents" already writes to). The generation reuses the existing
   `hearing-brief` output verbatim (decision #3) — no new generator, no transcription work.
2. **Save Recap flow (two writes).** `Save recap` → generate brief (existing) → on "Save to Client Profile":
   (a) create a client-scoped **Document** in the client profile Documents section, and (b) **write the recap
   into the client's Meri knowledge**. Both are **cross-service calls from intel-api → apps/api** (intel-api
   has no prod LLM/KB; mirrors how alert-actions already reach apps/api — `project_alert_actions_memo`).
   Confirm the exact endpoints during L6: the client-Documents create endpoint (Workspace/`ws_*`) and the
   per-client Meri/Clio KB ingest entry point. **Tenant + client isolation mandatory** — every write
   verifies `clientId ∈ caller tenantId` (`assertClientInTenant`; the cross-tenant class caught in the
   Radar integrated review; intel-api has no RLS).
3. **"Saved" sub-tab = filtered Documents view.** The profile LegiWatch → Saved lists that client's recap
   documents (by source=legiwatch-recap / doc kind), each linking back to its source hearing session. No
   bespoke store.
4. **Draft memo unchanged (decision #4).** The Feed/session "Draft memo" hand-off keeps today's Workspace
   pre-fill + formatting exactly — do not touch the memo template.
5. **Orientation "seen" flag (per-user).** Prefer a lightweight per-user preference (existing user-prefs
   store if present) over localStorage so it persists across devices; fall back to localStorage if no
   per-user pref endpoint exists. *Decide during L5 after confirming the prefs surface.*

---

## 5. Rename & rollout strategy

- **Flag:** reuse existing `tracker_v2` + `hearing_watch` (spec explicitly says reuse). No new flag; all 4
  tenants already flipped. The rename is cosmetic and ships un-gated once merged.
- **Route:** add `/legiwatch` as canonical; keep `/radar` as a permanent redirect (live alert emails and
  the client-profile `?tab` deep-links point at existing paths — must not 404).
- **Client-profile tab key** stays `tracker` internally (deep-links use it) — only the **label** changes to
  "LegiWatch"; add the `saved` sub-tab.
- **Codename:** keep "radar"/"tracker" in code/routes/DB where churn isn't worth it (same pattern as the
  Clio→Meri rename that kept `clio` in code). User-facing strings become "LegiWatch."

---

## 6. Open decisions — surfaced, not guessed

Most spec "open questions" are **already answered by the shipped build**; the remaining ones are yours:

- **Q7 (auto-resolve legal/ToS) — already handled, needs your counsel call.** Senate ISVP + congress.gov
  video work today; the **C-SPAN and YouTube resolver adapters ship DEFAULT OFF** pending legal
  (`RESOLVER_ENABLE_CSPAN` / `RESOLVER_ENABLE_YOUTUBE_LIVE`). No code change needed to plan; flip the env
  flags when cleared. (Tracked in `project_radar_followups` item 3.)
- **Q2 (global feed roll-up in v1)** — **already built** (P11). Keep.
- **Q4 (adopt unified watchlist superset)** — **already built** (P5). Keep.
- **Q9 (exact hand-off deep-link payloads)** — **already wired** (P10): memo→Workspace editor,
  outreach→`POST /api/engagement/outreach` contextPool then resume at Context, add-to-report toggle.
  Confirm these match the prototype's expectations during L1.
- **Decisions — RESOLVED 2026-07-05 (Ninja):**
  1. **Route rename** `/radar` → `/legiwatch` **with a redirect** (preserve `?tab`/`?client`). ✅
  2. **Save Recap** → write to **Meri knowledge** *and* the **client profile Documents section** (reuse the
     existing Documents store; no bespoke Saved table). ✅
  3. **Recap = the existing `hearing-brief`** output — no separate recap generator. ✅
  4. **Draft memo** keeps **today's formatting/pre-fill** unchanged. ✅

---

## 7. Risks / landmines (from this session's context)

- **Two local clones** — edit only the OneDrive canonical repo (`project_two_clones`).
- **Org monthly spend limit is currently hit** — subagent/workflow fan-out fails right now; the adversarial
  reviews must run inline until the limit is raised (claude.ai/admin-settings/usage).
- **Pre-existing prod issue (not this work):** the 2026-07-05 bake-check FAILED — intel alert *delivery* is
  down because the EventBridge invoker role's `ecs:RunTask` doesn't cover `capiro-dev-intel-api-*`. Fix that
  first if delivery matters for the demo (`project_radar_followups` item 1).
- **ffmpeg lesson** — any container CLI flag must be verified against the deployed build (the
  `-follow_redirects` regression).
- **Integrated-tree review is non-negotiable** — cross-tenant writes (esp. the new Saved-recap KB write)
  and client-scope leakage across tabs only surface in the merged tree.
- **intel-api has no RLS** — every new Saved-recap read/write must explicitly verify `clientId ∈ tenantId`.

---

## 8. Verification

- The **Gherkin doc is the acceptance suite** — each scenario maps to a phase's accept criteria above.
- Per-phase: `tsc` + prettier + tests; adversarial review (inline while spend limit holds); live smoke via
  Chrome MCP on a real client (cold + configured).
- L6 extra: prove tenant isolation on Saved-recap read/write with a regression test (zero cross-tenant
  rows), and confirm the KB write lands in the right client's knowledge.

---

## Delivery status & live verification (2026-07-06)

**SHIPPED to prod (capiro-dev / app.capiro.ai) + live-verified via browser:**

| Phase | PR | Live check |
|---|---|---|
| L0 rename → LegiWatch + /legiwatch (redirect /radar) | #266 | ✅ /radar→/legiwatch; nav+title "LegiWatch"; tabs Feed·Bills·Hearings·Configure |
| L1 calm Feed cards | #267 | ✅ collapse/expand, one severity cue (left edge), tag chip (#…), client label, "+N more" quotes, full action set on expand |
| L2 Bills recs-above-board | #270 | ✅ "Recommended by Meri" section always above a read-only "Your board"; Fit/probability/Track |
| L3 Hearings schedule-default + Watch live/recording + My Sessions | #271 | ✅ lands on Upcoming; "Watch live"; "My Sessions" with plain labels |
| L4 Configure explainer + "Your alerts for [client]" | #272 | ✅ priority/position explainer; "Your alerts for Aperture Defense Systems" (per-user) |
| L4b SMS "coming soon" | #280 | ✅ SMS badge "Coming soon", toggle disabled, "email is the live channel today" |
| L5 Orientation intro + How it works | #275 | ✅ "How it works" control; first-run modal + per-user seen flag (Vitest-covered) |
| L6 Save Recap → Documents + Meri knowledge | #278 | ✅ ended session → "Save recap" → Meri-synthesized recap preview → client picker → save (files a client Document; createAttachmentFromBuffer auto-indexes it into the client's Meri knowledge / client_doc_chunk) |

Gate on every phase: CI green, tsc clean (web + intel-api where touched), Vitest green (RadarPage 7/7), inline adversarial self-review (full workflow fan-out blocked by the org spend limit). No DB migrations. L7 = the inline integrated review (no blocking defects).

**Remaining follow-ons (re-measured against current `main` on 2026-07-28):**
1. **L2b — all-clients Bills roll-up is implemented.** The tenant-wide `_all/tracker/board` endpoint and client-labelled board exist. The audit found and fixed a later pagination regression: the web consumed only the first keyset page and silently hid tracked bills beyond it.
2. **L3 hearing refinements are partial.** Upcoming+Archive is now one segmented schedule. Still missing: watched archive → open its correlated saved session, and per-row `N watchlist matches` / recap-saved indicators (the session-list contract does not expose them).
3. **G7 remains intentionally partial.** Client-profile LegiWatch is a compact Board/Recs/Feed/Configure surface. Saved hearing recaps are truthfully filed under the existing Documents tab and indexed into Meri knowledge; there is no source-session metadata on the attachment contract yet, so do not present a fake Saved subview that cannot link back to its hearing.
