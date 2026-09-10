# Meri Phase 3 — memory and inspectable evidence

This extends draft PR #1557 on its existing Phase 2 head `f7d94f7d61bba061b5674b53e35854c59083f1af`. It addresses MW-03, MW-04 and MW-10 in the [Phase 0 register](phase0-contract-map-2026-09-09.md), plus the related mail capacity error and SAM source-health disclosure. It preserves the [Phase 2 repairs](phase2-implementation-2026-09-09.md), canonical services, governed Institutional Memory and provider reasoning. No migration or dependency change is required.

## Behavior

| Finding | Change | Verification focus |
| --- | --- | --- |
| MW-04: metadata presented as useful memory | Recall preserves approved bytes, provenance and governance while distinguishing factual content, known legacy event metadata and empty bodies. Fact-bearing captures get meaningful titles. New CRM candidates require an accepted finding in the same client scope and preserve its structured values and source excerpt; missing facts produce an insufficient-evidence outcome. Exact reads retain the canonical eligibility and client-wall checks. | Capability, person and facility facts; exact live legacy JSON shape; denied scope; non-active governance; full-body continuation; pending candidate creation and idempotency. |
| MW-04: slow or incomplete recall | Query embedding has a two-second budget outside the database transaction. A failed semantic transaction can fall back through a fresh authorized canonical read with an explicit limitation. Continuations bind to the caller, query, client scope and current canonical snapshot; changed content requires a restart. Repeated scans are counted once. | Hung provider; aborted transaction; changed snapshot; pagination boundaries; failure distinct from zero results. |
| MW-03: full source is only an excerpt | A fixed read-only source endpoint delegates to canonical mail, memory, client and document services. It pages long email/document content and preserves sender, date and record identifiers. Client records use their existing full-profile view. Source versions and the original answer excerpt are distinguished; deleted, ineligible, processing and denied sources have explicit states. | Passage beyond character 6,000; multiple messages; current-version changes; exact client/record identity; access denial; canonical document readiness. |
| MW-03: source navigation | Previous/Next and Back stay tied to the historical answer. Reload stores only a turn/citation locator for the current user, tenant and browser tab, then resolves it from authenticated conversation content. | Delayed hydration, another user/tenant/thread, missing citation, Back and reload; no content or scope in session storage. |
| MW-10: misleading coverage | Per-source counts distinguish matched, inspected, returned, displayed to the model and omitted from model evidence. Profile sections no longer borrow a whole-payload count. Repeated reads are not summed as distinct records. Task-required sources are distinct from supplementary context; detailed source failures remain visible. Context lists show meaningful names and can expand beyond five items. | A reconciled fixture manifest, capped profile sections, generic inquiries, explicit mail requirements, preserved diagnostics and list expansion. |
| MW-10: material claims | Existing provider instructions require a supporting admitted citation for material amounts, fiscal years, stages, deadlines and ranked opportunities, or an explicit assumption/unverified label. Relevant full passages must be read when previews are insufficient. | Prompt contract and citation metadata tests; actual generated-answer acceptance remains a deployment check. |
| Recoverable mail 503 | Read-only mail tools retry once only for the canonical database-busy JSON 503 with a valid short `Retry-After`, inside the original deadline and cancellation signal. Exhaustion remains an error. | Recovery, exhaustion, cancellation, deadline, business errors, auth errors and write exclusion. |
| Stale SAM catalog | The legacy SAM search now reuses canonical all-federal freshness information and reports stale, incomplete, never-synced and unknown coverage even when local matching rows are empty. | Exact success/attempt/failure information, failed/partial/running syncs, unknown health and zero matches. |

## Live evidence and data limits

A read-only inquiry in the existing L3 Harris QA thread asked for two approved memory facts, their actual text, source IDs, governance and completeness. Meri returned two approved active records containing only learning-event JSON, and correctly disclosed that those bodies did not contain capability facts. It also reported that more search pages remained unread. No records were changed.

The observed record IDs were `52c3cfa9-973e-4041-85ee-5a06155c19ad` and `72366e2d-f5e2-4b76-b685-d8a91b3c136a`, referencing learning sources `5d10b40f-611a-4f94-928a-5dbaa77fc8c1` and `03488f13-9a3f-43ec-82e4-18bd6cfa9562`. The stored summary was `crm_finding_accepted on crm.fill_with_meri, proposed layer client-steering.` with proposed authority/confidence and a generic instruction to review referenced evidence. This establishes a legacy canonical-content deficit, not a projection losing an already stored fact.

This change does not silently rewrite those approvals. Correcting historical records requires resolving the accepted source finding and its evidence, checking the same client scope and current access, then using the existing governed correction/proposal process. If the referenced source no longer contains the fact, the missing fact must remain unavailable. Existing review history must remain intact.

The two-second hung-provider test establishes a deterministic upper bound for waiting before the database read starts. It does not establish before/after deployed response latency. A reliable production timing pair and production logs tying the original mail 503 to a specific capacity incident were not available.

The all-federal SAM schedule is explicitly disabled in source pending its canary gate. The canonical dispatch and sync implementation exist. The search disclosure repair does not resume ingestion, verify the live schedule/key, or establish the cause of the September 8 sync failure. Those operational checks remain necessary before claiming current federal coverage.

## Validation

510 distinct tests passed across 38 focused suites, including Phase 2 regressions. The batches below do not double-count shared suites or reviewer reruns.

| Verification batch | Suites | Tests passed |
| --- | ---: | ---: |
| API: canonical memory, candidate ingestion and firm-data tools | 6 | 156 |
| API: context coverage projection | 2 | 32 |
| API: canonical source viewer | 1 | 18 |
| API: SAM freshness adapter | 1 | 2 |
| API: Phase 2 download, proxy, scope, context and target regressions | 6 | 73 |
| Orchestrator: mail retry, cancellation and existing transport | 3 | 26 |
| Orchestrator: provider prompt contract | 1 | 26 |
| Orchestrator: turn coverage, clean runtime, evidence projection and release citations | 4 | 49 |
| Orchestrator: exact source locator extraction | 1 | 4 |
| Web: combined downloads, scope, targets, coverage, source viewer and navigation | 13 | 124 |

Web and orchestrator TypeScript pass. API TypeScript reports exactly the same 10 diagnostics as the untouched Phase 2 baseline, with no new diagnostics. Shared and core package builds pass. The API Jest compatibility configuration maps the existing CJS `htmlparser2` entry and existing shared-package subpath declaration files; compiler diagnostics remain enabled. Tests isolate unrelated dependency graphs where necessary. Service and controller ports are controlled, so these checks do not establish deployed HTTP authentication, real PostgreSQL RLS, production OCR-provider access or generated-answer factual accuracy.

Two independent reviews found and resolved source-version, document-readability, legacy memory association, fact-excerpt and final-release citation propagation defects. A final projection regression also verifies that stale SAM receipts survive a shortened tool response. Review found no remaining actionable blockers; whitespace checks pass.

Historical profile-child citations that never stored their parent client may still be unavailable. The viewer does not guess the parent from the current picker. Newly captured locators preserve the exact parent identity; unsupported kinds use an existing safe full-source URL when available or explicitly disclose that no reader is available.

## Candidate deployment acceptance

This PR is not merged or deployed. The live inquiry above exercised the existing release, not this candidate. Phase 3's live exit gate remains open until these checks pass against the deployed candidate revision:

1. Ask for approved capability, person and facility facts with known source fixtures. Verify actual text, source IDs and current governance. Include a pending proposal, a controlling conflict, a revoked item and a metadata-only historical item; no unstored fact or unsearched governance state may be asserted.
2. Record elapsed time and tool receipts for a normal memory query and a controlled slow/failing embedding request. Cross the search and full-body pagination boundaries, mutate a controlled source between pages, and verify an honest restart/incompleteness response.
3. Open a long email with a unique passage beyond character 6,000 and a second message. Verify sender, date, thread/message IDs and the complete stored body. Exercise document sections, client child records, memory sources and a changed source version. Repeat Previous/Next, Back, reload and client-picker changes. Repeat denied reads using a controlled second identity.
4. Ask a generic knowledge question under a selected client and without one. Unrelated sources must not become requirements. Reconcile source counts against the fixture manifest and expand the context list beyond five items.
5. Request an opportunity comparison with material amounts, stages and deadlines. Read each cited passage and confirm that it supports its associated claim; unsupported values must be labelled assumptions or unverified. Stale SAM data must be described as stale, and zero local matches must remain distinct from source unavailability.
6. Exercise the known database-busy mail response and retry exhaustion with a controlled fault. Confirm one bounded retry and a visible limitation on failure. Verify the SAM canary and freshness ledger before making any source-currentness claim.

The Phase 2 live download, historical-scope and proposal-target acceptance checks also remain required for this combined PR.
