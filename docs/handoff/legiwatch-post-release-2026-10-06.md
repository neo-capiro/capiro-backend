# LegiWatch post-release verification — October 6, 2026

The source recovery in [PR 2117](https://github.com/neo-capiro/capirov2/pull/2117) and quality/capture changes in [PR 2122](https://github.com/neo-capiro/capirov2/pull/2122) are merged and shipped. PR 2122 passed 4,218 API, Intel API and web scope tests with no failures, skips or todos, plus native runtime, database, recording, recovery and client-impact qualification. Its immutable qualification is `legiwatch-remaining-quality-2026-10-06-qualification.json` at evidence commit `c04f34c70331a4c5f5aec17e8e9edb39129f1958`. This record supersedes the earlier remaining-issues snapshot.

## Verified repairs

| Finding | Verified result | Limit |
| --- | --- | --- |
| HB 1211 status | Live terminal companion substitution, SB 474 and Chapter 2026-92. | Individual historical bills were not all manually checked. |
| Florida Commerce room | Seven proceedings, 198 referrals and 26 retained members in the 20:52 UTC audit. Prior live February 10 acceptance found 13 agenda items and 12 bill links. | Retained inventory does not prove every publisher item was discovered. |
| Duplicate hearings and committee names | Proven aliases/misbound observations repaired; Golden Dome identifies Strategic Forces with three witnesses and three testimony documents. | Ambiguous identities remain separate. |
| Unknown clients/raw L3 identifier | Seven were archived clients; active scope and uppercase identifier normalization repaired and verified. | No cross-tenant leak was established. |
| Noisy alerts | Legal-defense exclusions, repeated-observation grouping and removal of internal fit scores shipped. | Distinct dates/revisions remain distinct; legacy alerts are retained. |
| Missing match trace | UI explicitly qualifies relevance as unverified. | Historical traces and severity are not invented or certified. |
| Four unavailable notification types | In-app categories/preferences, tenant scope and durable deduplication shipped; real drain succeeded. | External email remains disabled; not every category had a natural example. |
| Florida text and analysis | HB 1211 has four texts, three official analyses and chronological comparison. PR 2122 adds unsaved client-impact drafts. | Only complete retained text and substantive authorized client context can be used. |
| Budget visibility | Amounts and readable stages/funds visible; scoped filters and honest empty states verified. | Missing amounts are not presented as zero. |
| Watchlist and CSS | Shortcut visible beside Settings. PR 2131 restores all seven mobile Bill 360 tabs and increases the scrollable reading view from about 85 to 718 pixels at 390×844. Desktop navigation/layout and mobile page width passed live checks. | Detailed Impact and responsive acceptance are recorded separately; this is not a universal CSS certification. |

PR 2122 distinguishes static publisher qualification, recent intake receipts and retained counts. Live News acceptance shows dated WUSF/The Hill intake separately from unqualified catalog status; filtered public news no longer claims client relevance. The elapsed-hearing dialog disables recap generation without a transcript and explains why. Live hearing 119575 acceptance saved no draft.

The new Impact tab initially crashed live because its request omitted `/api` and received SPA HTML. [PR 2130](https://github.com/neo-capiro/capirov2/pull/2130) corrects the path and validates options and generated drafts before rendering; invalid responses stay local to the panel. Its shipped live acceptance loaded all four HB 1211 versions and produced one unsaved, safely qualified empty client-impact draft without a page crash. [PR 2131](https://github.com/neo-capiro/capirov2/pull/2131) then fixes the mobile drawer's broad tab-hiding rule and reading-area constraint. Each release passed 1,186 web tests in 335 suites, full web typechecking and 24 native operator/runtime checks; immutable build qualification and separate live evidence record the precise limits.

## Committee, calendar and news health

The SELECT-only audit at 20:52:58 UTC completed all 16 records with zero query errors. It enumerated 230 current federal committees (209 with retained exact-code proceedings) and 83 retained Florida identity rows (65 with alias-expanded proceedings and 57 with referrals). Florida rows include aliases/historical identities; these are not 83 independently verified current official committees. Counts summed across aliases are not unique people/bills.

All 230 federal entries have an enabled exact-code or parent source, but 21 have no retained exact-code proceedings; `sscm39` and `ssju27` also have no retained roster members. That does not prove those bodies published no hearings. In particular, `hszs00` has zero hearing observations/proceedings and 18 retained site updates, while the [official China Select Committee homepage](https://chinaselectcommittee.house.gov/) lists hearings dated September 16, July 15 and June 25, 2026. Its linked hearing archive returned HTTP 403 to the verification fetch. The generic committee-site adapter intentionally discovers updates/enrichment and returns no canonical events; central-feed success is therefore insufficient certification of this committee's archive coverage. This specific discovery gap and the two roster gaps require follow-up source/identity verification; no synthetic hearing or roster was inserted.

Of 152 enabled registered committee sources, 151 were healthy and JCT alone failed with HTTP 403. Earlier 20:34 UTC evidence had nine Florida HTTP 429 degradations; they recovered by this readback. Backoff and original failures are preserved. Disabled historical/duplicate source rows are not counted as enabled failures. Central discovery has three completed cursors. Current Florida 2026 House receipts cover September 29–October 20 with zero published events. The 2027 Senate request remains unavailable because the publisher serves 2026F. A partial Florida-calendar run can still have a succeeded heartbeat alongside `complete:false`/errors; the coverage ledger is authoritative. This remaining heartbeat presentation defect is not declared repaired.

The hourly RSS worker completed on the qualified image at 20:48 UTC with exit 0. Ten DHS and thirty Commerce articles are retained; selected-window live acceptance preserves publisher date/time precision. Reuters, State, Cato and Brookings remain unavailable through their original feeds, with no reviewed working replacement configured. The 74-row catalog is a reference inventory, not 74 configured feeds. Successful intake and retained articles do not prove historical or account-wide completeness.

## Automatic recording

Capture-all-public is true in the database. Stream-preflight, recording and media owners are enabled with effective Florida server-capture flags. Capture/media schedules pin qualified Intel image `sha256:8723f93700481b3cd34566dacbe0ef3253e8e2948901b5ca6dd84333d877be7e`; actual completed tasks on both pinned definitions exited 0. Recording now waits for the scheduled start window, persists fenced deferred jobs and rejects changed stale sources. Narrow recovery probes reopen empty blocked captures only after fresh allowed-source resolution, preserving attempts, manual stops, media and terminal outcomes.

The unrestricted future-row audit found zero canonical federal/Florida future hearings, including date-only rows on/after the Eastern date, with no upper date, visibility or event-status exclusion. Zero missing eligible schedules is therefore vacuous, not proof of complete future discovery or universal recording. Elapsed hearing 119575 is blocked with browser-only YouTube media, zero captured milliseconds and no effective server permission. It cannot be represented as server-recorded or forced into capture.

## Debrief and document boundaries

Golden Dome's saved/reloaded reviewed example has seven sections, 1,371 words and twelve key moments, with all 219 retained passages supplied and the closing request/deadline preserved. PR 2122 removes silent 400-character key-moment truncation: oversized complete summaries are withheld. Exact citations, complete source coverage and semantic review are required for client-impact drafts; refusals, partial output, timeouts and unavailable context withhold generation. These safeguards do not certify universal model correctness or replace human content review.

HB 1211's dataset attempt reserved eight provider units and exited 1. Independent `legal_source_receipt` readback found a reservation but no candidate/apply receipt; protected identity, four versions and other facts remained unchanged, and inventory is still absent. No apply ran. The failed receipt is not replayed or refunded. PR 2130 supplies safe stage diagnostics; a fresh retry requires qualification bound to its actual serving image, new reviewed preparation/preview and current quota/nonoverlap checks. Soft quota 28,000 and hard cap 30,000 remain unchanged. Retained documents cannot establish corpus completeness without exact provider inventory.

## Evidence

- Prior UI/debrief acceptance: `legiwatch-live-acceptance-2026-10-06.md`
- PR 2122 qualification: `legiwatch-remaining-quality-2026-10-06-qualification.json`
- Impact hotfix/live acceptance: `legiwatch-impact-route-2026-10-06-qualification.json`, `legiwatch-impact-live-2026-10-06.json`
- Mobile drawer qualification/live acceptance: `legiwatch-mobile-drawer-2026-10-06-qualification.json`, `legiwatch-mobile-live-2026-10-06.json`
- Private audit: `C:/dev/qa-legiwatch/remaining-issues-20261006/quality-post-release-audit-v4/`
- Scheduled-owner pins: private `quality-worker-pins/`
- Live screenshots/DOM: private `browser-live/`
- Failed provider receipts: private `hb1211-dataset-execution-v3/`

Private operational artifacts are intentionally not committed. Do not publish inherited definitions, credentials, archive bytes or tenant data.
