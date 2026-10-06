# LegiWatch remaining issues October 6 2026

This earlier snapshot is superseded by [post-release verification](./legiwatch-post-release-2026-10-06.md). The following text preserves the state before PR 2122; its references to unshipped candidates and unavailable client-impact analysis are historical.

Federal and Florida discovery, news recovery and debrief safeguards were merged and deployed in [PR 2117](https://github.com/neo-capiro/capirov2/pull/2117). The API, web app and six affected ingestion schedules use the qualified release. The full gate passed 4,090 API, Intel API and web tests with zero failures or skips, plus database and recording qualification.

The latest production readback has 151 of 152 enabled committee sources healthy, three completed federal discovery cursors, ten retained DHS articles and thirty Commerce articles. Four news feeds and JCT remain failed. Newly confirmed publisher status and debrief presentation defects have tested private candidate patches; they are not deployed. Complete future hearing coverage and universal server recording are not certified.

## Original QA findings

| Finding | Verified disposition | Remaining boundary |
| --- | --- | --- |
| HB 1211 introduced/committee-next-step status | Live terminal companion-substitution status, SB 474 and Chapter 2026-92 are present. | General Florida terminal mapping is implemented; no claim that every historical provider record was individually checked. |
| Empty House Commerce room | Verified seven proceedings, 198 referrals; February 10 has 13 agenda entries and 12 linked bills. Referral pagination repaired. | Each committee's retained inventory is not certification of every publisher item. |
| Duplicate hearings and names; Golden Dome identity | Proven canonical aliases and misbound observations repaired. Unified filters. Golden Dome shows Strategic Forces, three witnesses and three testimony documents. | Ambiguous historical identities remain unmerged. |
| Unknown organizations and raw L3 identifier | Seven organizations were archived clients. Active Portfolio scope and uppercase identifier normalization repaired and live verified. | No cross-tenant leak was established by this investigation. |
| Legal-defense noise, repeated NDAA cards, fit labels | Legal-defense exclusions, reviewed historical corrections, exact observation grouping and visible score removal shipped. | Different dates/versions remain distinct; alert history retained. |
| Missing critical match trace | Presentation states relevance is unverified and qualifies stored priority. | Missing historical traces are not regenerated; legacy severity is not certified. |
| Four unavailable notifications | Four in-app categories, preferences, tenant scope and durable deduplication implemented and shipped; real drain succeeded. | No naturally occurring example of every category was observed. External email remains disabled. |
| Florida depth | HB 1211 has four texts and three official analyses; chronological reading comparison and raw/numeric changes are available. | Generated substantive client-impact analysis remains unavailable. |
| Budget visibility | Visible amounts and readable stages/funds, scoped filters and honest empty states shipped and live verified. | Unavailable funding data is not presented as zero. |
| Watchlist discoverability and CSS | Watchlist & alerts shortcut visible beside Settings, desktop/mobile acceptance completed in prior release. | This follow-up focused on remaining backend/data defects, not a new exhaustive UI audit. |

## Corrections in PR 2117

Discovery now uses dedicated completed-ingestion cursors rather than probe timestamps. Partial observations survive failures without advancing affected cursors, and incomplete worker runs produce failed heartbeat status. Congress timeout retry is bounded to one per pass. Existing schema/roles/flags/schedules are preserved.

DHS and Commerce have strictly parsed official publisher alternatives, limited to the current window. Original feed failures remain recorded. DHS date-only publication is retained as day precision and displayed without an invented time. Commerce uses publisher publication date, not creation or update timestamps.

Selected bill inventory receives a timestamp only after exact provider identity/session/revision validation. This does not falsely update a whole-bill source check. HB 1211 still has no inventory or whole-bill check timestamp in the 17:15 UTC readback. The explicit `sync-legal-research` hydration action must run for the selected bill; none of the six released schedules invokes it. A validated one-bill manifest permits seven documents, preserves quota/session/hash guards, and remains unapplied. Existing official documents and comparison remain available.

Elapsed hearings without transcripts cannot generate future preparation as an apparent debrief. A live request for hearing 119575 returned the explicit recap-unavailable response and saved no draft. Its dialog still incorrectly promises preparation before submission; the prepared UI patch distinguishes unknown transcript availability from confirmed absence and disables unavailable generation.

## Remaining source and capture gaps

The live News publisher coverage panel incorrectly labels static coverage qualification as “Configured source.” Its 74 rows are a reference inventory: 70 have no source URL and an account-qualification-unavailable reason, while four have older limited-current-feed qualification. This is not 74 failed feeds. The Hill and Politico have successful separate RSS intake despite unqualified catalog rows; WUSF's partial catalog status is from September 14. Many zero-article newspaper/TV rows do lack a qualified configured source. A follow-up correction must separate coverage qualification, recent feed intake receipts/errors and retained article counts; counts alone cannot prove current ingestion health.

Production-network checks at 16:30 UTC found the DHS index, Commerce API and reviewed Ways and Means event page reachable; JCT returned 403. The qualified news worker subsequently retained ten DHS and thirty Commerce articles. The live page displays all ten DHS items with date-only publication labels, and two Commerce items in the selected seven-day window with publisher times. Original failed-feed receipts remain present and historical completeness remains unqualified.

At 17:15 UTC, 151 of 152 enabled registered sources were healthy and JCT alone remained failing. The ordinary committee enrichment heartbeat succeeded with zero errors after release. Source availability is not a guarantee that every agenda, bill relation or update is ingested. Florida 2026 calendars have complete window receipts through October 20; the requested 2027 Senate session is unavailable because the publisher serves 2026F. Earlier 429 failures remain recorded and publisher backoff is preserved. Reuters, State, Cato and Brookings feeds remain failed, with no reviewed usable replacement configured.

Capture-all-public and Florida capture flags are enabled, and recording workers run. The retained future federal/Florida canonical hearing count was zero. That is insufficient evidence of complete future discovery or universal recording. Hearing 119575 has browser-only YouTube media and no approved server source or permission; it cannot be represented as server-recorded.

A source-policy BLOCKED capture can fail to recover after a later approved source appears. No current approved-source recovery case was proved. Safe future recovery needs a bounded disposition probe while still blocked, followed by a fresh successful allowed resolution and an optimistic reopening of an empty capture. It must preserve manual stops, attempts, media and terminal outcomes. Details are recorded in the independent lifecycle review.

## Debrief evidence and remaining quality work

Golden Dome's saved/reloaded debrief has seven reviewed sections, 1,371 words and twelve key moments. All 219 retained source passages were supplied, with the closing request and deadline preserved. This establishes that saved example's acceptance, not universal model correctness.

Independent review found a separate deterministic key-moment defect: the references helper silently truncates an already validated summary to 400 characters. A grounded 454-character diagnostic lost its final qualifier. The prepared private patch rejects oversized complete summaries and includes the limit in generation instructions. Its 26 reference tests passed. The separate elapsed-hearing UI patch passed 27 tests and full web typecheck; the publisher coverage patch passed 30 tests and Intel/web typechecks. These patches are not part of the deployed release and need integration and release qualification.

Source attribution/paraphrase still requires content review. Missing recordings cannot yield a truthful transcript-grounded recap. Missing legacy alert match traces remain unverified, and substantive client-specific bill impact analysis is unavailable.

## Evidence

- Prior source/data fixes: `docs/handoff/legiwatch-qa-2026-10-04-fixes.md`
- Initial rollout: `docs/handoff/legiwatch-qa-2026-10-05-rollout.md`
- UI and saved hearing acceptance: `docs/handoff/legiwatch-live-acceptance-2026-10-06.md`
- This release qualification: `docs/handoff/legiwatch-source-recovery-2026-10-06-qualification.json`
- This release live acceptance: `docs/handoff/legiwatch-source-recovery-2026-10-06-live-acceptance.json`
- Current private diagnostic: `C:/dev/qa-legiwatch/remaining-issues-20261006/server-source-check/summary.json`
- Deployed source: `e6ff0250b6f79f92bbfd16edb69d48f27e96883f`; immutable promotion receipts and authenticated live acceptance are separate records.
