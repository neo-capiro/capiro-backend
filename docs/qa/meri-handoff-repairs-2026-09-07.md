# Meri handoff repairs — implementation verification

Branch: `codex/meri-handoff-repairs-2026-09-07`  
Original verified base: `8c4735e6bb31a0d920a9ff508f165866c0be5454`.
September 8 inbox follow-up integrates main revision `93f0dbd09166abf941029d43ac11563ba19aaac0`; its three unrelated outreach changes and all five original repairs are preserved.

## Scope and result

This change addresses the five failures recorded in the September 7 Meri handoff. Provider models, reasoning efforts, matching services, governed recall and deployment configuration are unchanged. The provider continues to decide substantive reasoning and tool use.

| Confirmed failure | Repair and regression coverage |
| --- | --- |
| Long client-linked waits without useful progress | Observe the existing Context Plane stage timer and actual stream events. Show preparation, retrieval, provider and tool status with elapsed time. No fabricated work or completion estimates. Stop prevents entry into the assistant runtime after preparation finishes; auxiliary progress failures cannot fail a successful context read. |
| Conflicting saved coverage | The API wrapper overwrote the clean runtime's reconciled coverage with its original packet. Preserve authenticated turn receipts and restored-source status, while retaining the API's signed packet, plan and initial failures. Existing saved failed searches say “Could not read” instead of “Not searched.” |
| Inherited PDF missing from a follow-up's Evidence panel | Carry bounded, reauthorized document observations in signed context; preserve document identity, exact saved excerpt, page/section, limits and original citation number. Include sources cited only inside generated artifacts. Reuse canonical document authorization/readiness/hash validation. |
| Raw JSON Word preview | Render the persisted Word specification as headings, paragraphs, lists, tables and supported embedded charts. Copy produces readable text; download uses the existing canonical Office renderer. |
| Prior turn's work shown during the new pending response | Clear live work before request preparation and fence callbacks with existing request/identity ownership. Preserve saved message receipts. Distinguish durable prompt acceptance from provider startup and HTTP headers, including Stop before the first event. |

## Continuity safeguards

- Document observations pass current conversation ownership, client scope, ethical-wall and canonical document permission/readiness/hash checks. Failed or changed sources are withheld. Institutional memory is not replayed through this mechanism.
- Legacy citations without saved full excerpts retain only their existing truncated snippet, with explicit missing extraction metadata. Preparation never invokes visual OCR to recreate old pages. The provider can request the exact page through the canonical reader when needed.
- Source validation is bounded; omitted and unavailable observations are disclosed to the provider. Citation allocation preserves retained identities and uses available supported numbers instead of advancing beyond the validator's range.
- Word/PowerPoint source references are normalized before canonical artifact persistence. Research prompt snapshots exclude saved document observation payloads; exact excerpts reach the provider through reauthorized signed context.
- A `turn_accepted` receipt follows successful user-message persistence. Setup errors remain classified; progress-only failures cannot consume an unsaved draft.

## Verification

Focused regression runs cover changed API, orchestrator, shared/core authentication and web paths, including the clean runtime's JSON/SSE coverage result, saved/reloaded Evidence rendering, document authorization/hash changes, citation numbering, artifact-only sources, research handoffs, early/late cancellation, previous-message work, drafts/imports, rename and feedback identity.

The canonical DOCX renderer was exercised in memory on creation and regeneration from its stored specification. Both produced valid OOXML with expected title/heading styles, paragraphs, bullets, a table, citations and limitation text. This is not a production download or pagination inspection.

Typecheck evidence:

- Shared/core package builds: pass.
- Web normal TypeScript check: pass, zero diagnostics. Untouched main also passes using the same resolved dependencies.
- Orchestrator normal TypeScript check: pass.
- API production TypeScript check: pass.
- API full TypeScript check, which includes repository tests: nine existing errors. A separate exact-main source copy reproduces all nine diagnostics byte-for-byte; no introduced diagnostics. Baseline and changed diagnostic logs have SHA-256 `68d646acd0cc53454652e91fc330ea9df5ea7598e38990e594ba83f6b66a3755`.

The checkout is authenticated exact-main Git data, with all production API/web TypeScript, the entire orchestrator, Meri tests and shared packages present. Unrelated tests, documents and binary assets remain sparse. Local dependency caches were reconciled without package or lockfile changes.

## Deployment and remaining live checks

No merge or deployment was performed by this change. PRs #1502, #1507 and #1514 are independently confirmed merged. Their deployment status, the active production runtime and production stage timings were not independently verified. The browser connected and listed the expected QA tabs, but subsequent page inspection stalled and returned no page content. Empty GitHub status/workflow results are not deployment evidence.

This is an implementation verification, not a clean production QA sign-off. Multi-minute production latency is not claimed resolved: stage progress is repaired, and live timing is still needed to identify and measure the remaining bottleneck. Cancellation checks prevent the next assistant/provider stage; they do not claim to interrupt an already-running database query.

After deployment, retest the handoff's inventory, bounded Federal Market search, page-22 follow-up Word briefing, immediate/reloaded Evidence, and Stop both before and after the acceptance receipt. Confirm the deployed commit first. Inspect an actual exported DOCX and separately verify asynchronous Deep Research completion/recovery. The handoff's broader funding, long-hearing, mixed-page, forced-downgrade and government-affairs quality gates remain unclaimed. Use read-only labelled QA threads; do not alter real client records, send communications or change governed memory for a fixture.


## September 8 follow-up: two-week inbox activity

The reported answer is reproducible as a code-path failure, but the user's production mailbox was not inspected. Both providers previously discarded newly encountered mail when no client matched; a connected mailbox could therefore have an empty local corpus. List had no date/folder inventory and search required a keyword/person, encouraging the meaningless keyword `the`. Selected-client injection could also incorrectly narrow the user's own inbox, and the shared grounding kernel mandated an unrelated legislative disclaimer.

Repairs:

- Microsoft 365 and Gmail retain unassociated mail in the existing nullable-client mail tables. Recovery uses the existing bounded 365-day backfill and provider page caps, with versioned resumable state. Existing manual associations and removal handling are preserved. Pending delta/history changes are processed around replay so an automatic recovery does not silently discard pending deletions.
- Both assistant tools call the canonical Engagement service mailbox reader. `withinDays=14, folder=inbox` is a valid inventory without a keyword; explicit client filtering, literal content/person lookup, tenant and connection-owner boundaries remain supported. Active messages are deduplicated before pagination, with message/thread IDs retained for citations and follow-up reads.
- Pages expose `offset`, `nextOffset`, `asOf`, query identity, counts and date bounds. New historical backfill rows are excluded from continuation by ingestion time. Existing-row provider updates/removals can still change pages; these reads do not claim a transactional database snapshot. Bounded paging or incomplete sync must remain disclosed.
- Canonical mail coverage uses the provider's mail state, including backfill, continuation, repair and errors. A successful calendar or general connection timestamp does not establish mail freshness. Tool previews are abbreviated; the former claim that full message bodies never sync was removed. Stale completed mail syncs retain the existing 48-hour freshness limit, and unresolved deleted-folder recovery remains an explicit coverage gap.
- Large model-facing mail results retain visible messages, exact scope, health and continuation without duplicating the thread envelope. Coverage combines only contiguous pages of the same query, counts repeats once, and uses the displayed records. The bounded `get_email_thread` tool reuses canonical thread authorization and reads stored body sections beyond previews; canonical citations use the actual visible message IDs.
- The LLM continues to interpret the request and choose tools. Shared descriptions and V2/V3/legacy scope handling permit the owner's inbox while a client is selected, retaining explicit mismatched-client rejection. No new phrase classifier, model override or planner was added. Missing evidence is explained once in source-specific language without forced tool syntax or legislative boilerplate.

Validation includes canonical-query and tool-delegation regressions, real generated SQL executed in isolated PostgreSQL/PGlite, provider replay/removal/manual-association fixtures, mail coverage and authorization tests, and full provider-loop scope tests. The optional reproducible SQL harness is `apps/api/scripts/verify-mail-query-postgres.cjs`; it uses fixture data only and an already available PGlite installation, without a repository dependency change. The final focused runs include 33 canonical mailbox/schema tests, 22 provider replay/preservation tests, 48 mail coverage/authorization tests, 142 orchestrator tests, 56 API prompt/citation tests, and 23 projection/clean-assistant tests (some suites overlap). The PostgreSQL fixture passes 11 scenarios executing 48 generated queries. Shared build and production API, web and orchestrator typechecks pass. Three existing static scope-checker assertions were independently reproduced on unchanged source and remain outside this repair. The full API test-inclusive typecheck still produces the same nine baseline errors byte-for-byte (hash above).

No production email was read, sent, deleted, synced or repaired during this work. Deployment followed by scheduled bounded recovery is required before previously skipped messages become available. A connected mailbox with no stored mail must still be reported as unavailable evidence until that recovery is verified. After deployment, confirm mail-specific recovery completion and rerun the exact two-week inbox question; verify an activity summary grounded in returned messages or an accurate source-specific coverage limitation.
