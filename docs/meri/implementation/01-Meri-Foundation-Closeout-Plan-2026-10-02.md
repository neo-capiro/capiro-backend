# Meri Foundation and Reliability Closeout Plan

> **Superseded for acceptance (October 5, 2026):** the C2/C4 acceptance procedure is replaced by [01-Meri-Acceptance-Simplified-2026-10-05.md](01-Meri-Acceptance-Simplified-2026-10-05.md). The case list and the obligations deferred there are unchanged.

Prepared for Neo Martinez and the lead implementation agent. October 2, 2026, America/New_York.

**Objective:** finish file 01 in the existing Capiro codebase, preserve the substantial work already merged, and demonstrate reliable user outcomes. The remaining work is focused integration, repairs, and acceptance. It is not another architecture build.

This document replaces the previous execution schedule for the remaining file-01 work. It does not delete or weaken the original requirements, fixtures, case IDs, hard gates, or authority boundaries. The original `docs/meri/implementation/01-Meri-Foundation-and-Reliability.md` remains the acceptance contract. Later product work and conditional experiments retain their original ownership.

**Operating rule:** one lead, one release candidate at a time, small changes, actual user-flow verification, and a concise current status. Neo should not have to coordinate parallel workstreams.

## 1. Starting point and evidence limits

Repository: `https://github.com/neo-capiro/capirov2`.

The planning audit examined main `723735ed1f5c562ab10e6077c67261285ea102fd`, committed October 2 at 23:05:43 UTC, and reconfirmed that main had not advanced while this closeout plan was prepared. Refresh main and deployment evidence before implementation. Never apply an old patch solely because an earlier plan listed it as missing.

| Area | Observed starting point | Remaining work |
| --- | --- | --- |
| Tool execution and approvals | Typed outcomes, argument validation, incomplete-call protection, duplicate-write controls, acknowledgment reconciliation, and in-Meri approval UI exist. | Verify complete ordinary-user flows, effect counts, durable receipts, and failure recovery. |
| Institutional Memory | Canonical store and governed proposals remain authoritative. Current retrieval applies eligibility before ranking. | Prove older-than-500 recall, immediate approved recall, revocation, supersession, scope changes, and reconnect behavior through the served route. |
| Commitments & Deliverables | The named read-only skill and protected contract remain in source. | Run all seven CD cases, including source coverage, Monday states, deduplication, and the separately approved follow-up action. |
| Planning and long tasks | Research plan validation, bounded calls, no-progress detection, durable ownership, steering, cancellation, and a typed child interface exist. | Qualify actual worker loss and recovery; establish uniform token/cost enforcement and whole-request context budgeting. |
| Tools | Progressive discovery exists. Federal-award reads now use a shared owner service; fiscal-year/pagination repairs have landed. | Validate actual provider exposure, caller compatibility, and remaining aliases. Do not repeat completed owner consolidation. |
| Narrative and JEV | Correction hooks and telemetry plumbing exist. | Verify localized correction, useful professional answers, accurate coverage statements, and joined exported traces. |
| Live acceptance | Latest status records 0 of 75 fully accepted, 1 original case attempted, 74 not run. Case 01 produced a correct core answer but did not complete its acceptance obligations. | Finish the existing acceptance contract. Zero fully accepted is not zero implementation. |
| Latest qualification | Source `7c04ca368fbccc84d33c720ce7a20b9201bf6e99` has a qualified coverage-warning repair: 1,489 orchestrator tests passed, 2 pending, and 26 offline cases passed. | Its record says live acceptance NOT_RUN. Mail timeout repair is separately pending. |

The last checked-in deployment/browser checkpoint identifies API515 and orchestrator103 at source `6be5a560d5addaa1844f0687898c34a249089f76`, with WebVNext388 unchanged. It records a passing concise answer, a successful scoped task count with a contradictory footer, and a mailbox 503 reported honestly. The later coverage repair is qualified, but this audit did not establish its deployment. These are repository receipts, not a new independent AWS inspection.

The audit inspected critical paths and saved evidence; it did not execute the whole application suite or prove every file correct. Treat remaining code findings as issues to reproduce or close with precise counterevidence.

## 2. What stays fixed

Keep the current monorepo, native Meri runtime, auth, tenant/client/ethical walls, Context Plane, canonical Institutional Memory, approved-action authority, domain services, artifact storage, and qualified ingestion. Keep existing NVIDIA and government-data owners. Meri remains the existing assistant; no separate Defense Chat.

All normal memory, action, procedure, and draft approvals stay inside `/meri`. A Settings detour fails acceptance. Shared memory requires the existing governance decision; summaries, working notes, and specialist conclusions do not become approved institutional facts automatically.

Keep the currently authorized production model/provider configuration stable while measuring these fixes. Do not change architecture, model, source corpus, and prompt simultaneously and then attribute the improvement to one of them.

File 02 owns the full coworker and Congressional Drafting workbench. File 03 owns specialist comparisons and justified training. Their preparatory documentation may continue without blocking this closeout, but do not activate features that depend on unqualified file-01 boundaries.

New Fargate capacity, a new model server, LangGraph, a full Hermes/LibreChat fork, Docling, extra connectors, database relocation, and comprehensive legacy cleanup are not prerequisites. Preserve their original conditional decisions; activate one only when its measured trigger and existing authority apply. Do not reclassify a mandatory foundation behavior as optional.

## 3. Change the delivery process

| First-run problem | Closeout rule |
| --- | --- |
| Very large integration PRs obscured responsibility and regressions. | One coherent behavior or contract per PR. Review before merging; deploy affected components after qualification. Avoid stacking unrelated work on one long-lived branch. |
| Many simultaneous workers touched shared services and produced difficult integration. | One lead owns integration and releases. Delegation is optional: at most one active implementation task and one independent review/test task. Assign nonoverlapping files. |
| Tests and capture infrastructure expanded before enough real workflows ran. | Reproduce through the real route first. Extend the harness only for a named failing acceptance assertion that existing tools cannot capture. No new general-purpose evaluation platform. |
| Passing tests, merged code, and builds were treated as interchangeable progress. | Track implemented, merged, deployed, and accepted separately. A build does not move an acceptance row to PASS. |
| Failures in setup or result collection consumed repeated paid attempts. | Preflight one representative case per fixture family, capture failure output before assertions, and regrade saved outputs. Classify product, fixture, harness, provider, and access failures separately. |
| Historical status obscured current truth. | Maintain one short current status and one requirement matrix. Link history; stop prepending another full narrative to a growing status file. |
| Strong controls became generic answer warnings or blocked useful work. | Apply controls at actual scope/effect boundaries. Localize uncertainty to the unsupported source or claim and return supported work. |

Use a review trigger of roughly 20 production files or 500 logical production lines for a proposed patch. Larger changes require the lead to explain why splitting would make the change less safe. This is a review aid, not an automatic stop or a new request for Neo's permission. Tests, generated artifacts, and documentation do not count as production lines.

Timebox the initial reconciliation to one working session. If a fixture or harness problem consumes roughly two focused hours without allowing a case to run, record the precise blocker and move an independent fixture family forward while repairing the common cause. Do not waive the blocked assertion or replace it with a mock answer.

Keep one shared-contract owner. Workers return a diff/commit, actual test commands and exits, reproduction evidence, and limitations. The lead verifies the result; a worker's prose is not evidence of a commit, passing test, or deployment. Retain working authorized coding-agent configurations rather than spending this closeout experimenting with providers or advertised reasoning modes.

## 4. Sequential execution and release gates

The lead runs C0 through C5. These are closeout gates, not new product workstreams. Already-qualified behavior should be verified and retained, not reimplemented. Small fixes may ship between gates using the proportional release process in section 9. If an earlier case exposes a later-listed prerequisite, pull that specific repair forward and return to the case; do not create an artificial wait between gates.

| Gate | Purpose | Exit evidence |
| --- | --- | --- |
| C0 | Reconcile the baseline once. | Current source/deployment identities, one requirement matrix, first runnable user flow, and explicit fixture blockers if any. |
| C1 | Finish the observed basic-user defects. | Accurate coverage footer, working mailbox query, scoped task result, and persisted answers through the actual workspace. |
| C2 | Prove memory, approvals, artifacts, and C&D. | Affected memory/approval/artifact cases and all CD cases pass with source/receipt checks; runtime probes feed C3. |
| C3 | Close and prove runtime/context/narrative gaps. | Ordinary-chat budget coverage, complete input budgeting, recovery/fault cases, JEV repair, and joined trace evidence. |
| C4 | Finish the full acceptance sweep. | Every original case executed; required variants, repeats, memory cases, and human review recorded; remaining failures repaired or explicitly unresolved. |
| C5 | Qualify the integrated release and hand over. | Compatible deployed artifacts verified where authorized, rollback record, complete acceptance accounting, and accurate file-02 readiness decision. |

### C0 — Reconcile once and start execution

1. Read current repository instructions and preserve existing worktrees, branches, changes, and active-run records. Fetch current main and relevant PRs. Do not reset or replay merged work.
2. Read the original file 01, `STATUS.md`, `01-requirements.md`, `01-handover.md`, `01-source-acquisition.md`, `01-source-inventory.json`, and `01-memory-strategy-acceptance.md`. Reconcile only changes since the audited SHA. Review actual package scripts before choosing commands; do not invent CLI entry points.
3. Identify the source/config/image actually served by web, API, and orchestrator. Record model/mode/flags, compatible schema and rollback artifact. If inaccessible, mark deployment UNVERIFIED and continue local qualification.
4. Update the existing requirement matrix with one current row per requirement, preserving original IDs. Use columns: requirement; current implementation path; owner; merged SHA; deployed identity; acceptance state; evidence; exact next action. Keep historical receipts linked, not overwritten.
5. Inspect the existing native test claims and aggregate budget journal. Reuse their authority and remaining budget; preserve uncertain billing, committed approvals, fixture lineage, and prior failures. Do not initialize a replacement journal, reapprove an already approved item, or reset shared state to erase a failure.
6. Preflight one existing fixture: ordinary authorized actor, selected client, canonical source readable, governed endpoint reachable, provider reservation feasible, capture terminal readback working, and sandbox write sink isolated if relevant. Freeze the benchmark semantic clock at September 26, 2026, 12:00 America/New_York without changing real auth/lease/timeout clocks. A blocked benchmark fixture does not prevent an independently authorized read-only C1 reproduction; record and repair the blocker without presenting that reproduction as fixture acceptance.
7. Queue the first C1 verification or fix. Do not wait for every fixture family, a new report generator, a fresh server, or a new dataset.

Done when the lead can name the current running version, first affected workflow, existing test mechanism, and next release. Do not spend this gate cataloging every unrelated monorepo feature.

### C1 — Finish the observed user-facing repairs

**Coverage warnings:** inspect whether `7c04ca368...` or a descendant has already been deployed. If not, finish its existing qualification/promotion path. Reuse the qualified artifact when source and configuration still match. Verify that successful scoped reads no longer receive contradictory generic warnings; partial or failed reads still identify their actual limitation. Do not remove all warnings to fix one overbroad warning.

**Mail search:** reproduce the observed 503 through the actual tool and trace it to the failing boundary. Distinguish query timeout, pool/lock delay, adapter timeout, and runtime deadline. Inspect tenant/mailbox filters, pagination, query plan, existing index, and deadline alignment. Prefer a bounded query/index/adapter repair supported by evidence. Do not simply raise database capacity and all timeouts until the symptom disappears. Any necessary index/schema change follows the existing forward-only migration owner.

**Task lookup and simple answers:** verify scoped task assignment/counting and ordinary concise responses remain correct. A successful tool returning a count must not be followed by a contradictory evidence disclaimer or an unrelated legislative tool call.

Run and retain these outcomes: a concise no-tool answer; known-result and zero-result task reads; known-result and zero-result mail reads; controlled mail failure; and persisted answer after reload. Synthetic known-result records belong in the isolated test environment. Read-only checks in an existing approved account are useful regression evidence but do not replace the original synthetic permission cases.

Record first useful content, terminal latency, tool count, failure state, and source coverage. A browser observation upper bound is not a measured p95 or first-token latency.

Ship each qualified repair without waiting for full-suite completion. C1 is complete only when the served candidate exhibits the repaired behavior. If access is unavailable, mark it locally qualified with the exact remaining verification step; continue useful C2/C3 work without calling C1 complete.

### C2 — Close memory, approvals, artifacts, and commitments

Begin with original cases 01, 12, 14, 17, 20, 46, 51, 72, 74, CD-02, and CD-05. Cases 72/74 also feed C3. Reuse the same captured evidence when it satisfies both requirements; preserve their separate case identities. Then finish the full affected memory, approval, and artifact families plus all CD cases.

**Institutional Memory:**

- Prove the current eligible source is found before candidate limits, including the approved item older than 500 newer eligible records. A truthful failure to find that required item still fails the recall case.
- Prove approved memory is available on the next ordinary turn. Inspect the existing approval-to-projection/outbox path if delayed; do not bypass governance or create a second recall store.
- Revoke or supersede a source in controlled fixtures and verify it cannot return through cached passages, summaries, old handles, resumed research, citations, or exports. Recheck authority at use/delivery boundaries, not only initial search.
- Exercise client switch, ordinary-role denial, ethical walls, private versus firm memory, and conflicting/stale review cards. Six pending proposals must remain discoverable after reload.
- Preserve user corrections and useful eligible evidence during compaction; working summaries remain noncanonical.

**Approvals and effects:** show proposal, correct scope/payload, approve/reject/error/unknown state, and durable receipt inside `/meri`. Test both a known failed attempt and accepted-effect/response-loss ambiguity. Only the known failed attempt is safely retryable without reconciliation. Query authoritative operation status before resending an uncertain effect; count exactly one committed effect in the disposable sink.

**Files and artifacts:** run original 40–46 against actual authorized bytes: PDF page, PPTX slide versus notes, prior-turn spreadsheet after compaction, cross-client denial, pending extraction, current paginated report, and generated download. Check content, revision, permissions, and checksum; a generated URL or mock preview is insufficient. Current source qualification for this family must be integrated into the central evaluator.

**Tools and existing callers:** verify selected/exposed/invoked schemas on the governed route. Preserve structured readers, discovery tools, canonical memory, paging, fiscal-year filters, and current editor/strategy callers. Consolidate remaining aliases through the existing domain owner with compatibility tests. Retaining a documented alias is acceptable when removing it would break a caller; do not optimize for an arbitrary tool count or introduce an untyped mega-tool.

**Commitments & Deliverables is an unchanged contract:**

- Keep visible `commitments_audit`, editable starter, `requiresClient: true`, general/client launch scopes, selected-client execution, and `readOnly: true`.
- Cross-check authorized emails, meeting notes/transcripts, debriefs, native tasks, action items, relevant documents, and Monday boards mapped to the client or explicitly supplied and authorized.
- Show what was promised, when/where, evidenced owner/date or unknown, exact status, sources, and needed follow-up. The only statuses are `completed`, `in progress`, and `no record of action`.
- Deduplicate the same promise while preserving underlying record IDs. Exclude unrelated personal boards, unrelated board items, cross-client content, and unassigned suggestions. Do not invent a promise, completion, owner, or due date.
- Report Monday as checked, disconnected, unavailable, or not mapped. Unread pages and unavailable categories prevent exhaustive absence claims. Older promises must not disappear behind a silent seven-day cutoff.
- The audit creates zero tasks. A separately requested follow-up uses a separate in-Meri approval and one reconciled logical operation.

Run CD-01 through CD-07 in full, including their variants. Do not substitute seven unit tests for seven product cases.

### C3 — Prove bounded long work and useful responses

**A. Uniform run budgets**

Trace ordinary chat, research, child work, retries, and JEV to the actual accounting owner. The audited `MeriRunBudget` bounds attempts/time, but durable provider reservation is optional; ordinary-chat fallback can have no accounting adapter. Either demonstrate equivalent enforcement elsewhere with served evidence or connect ordinary production runs to the existing budget service.

Use one parent budget identity with atomic admission, attempt/operation identity, conservative input/output reservation, actual usage settlement when known, explicit uncertain spend, deadline, bounded concurrency, and remaining capacity for final synthesis. Include child/JEV/retry/compression work where it incurs provider cost. Counters must survive recovery for durable work. A disconnect or new worker must not reset the spend ceiling. Do not attach production chat to a synthetic capture policy to obtain accounting.

Choose compatible initial ceilings from existing effective policy and measured payloads. Preflight synthetic reservations so an undersized test ceiling does not prevent the first model request again. Preserve aggregate spend authorization; more budget is not assumed. The first repair must demonstrate both a normal successful answer and an intentionally exhausted run returning a truthful bounded outcome.

**B. Whole-request context budgeting**

The audited compaction helper bounds persisted history and protected state; it explicitly is not a whole-provider-input budget. At the last request-construction boundary, account for system instructions, tool schemas, current input, history, memory, tool outputs, child results, and JEV repair context. Reserve completion/reasoning capacity according to the effective provider contract and use model-appropriate token measurement or a documented conservative estimate.

Reuse existing compaction and evidence handles. Compact before the request would exceed its allowance. Retain objective, selected client, user corrections, source versions, pending proposals, decision state, and valid tool-call/output pairing. Keep bulky raw content behind current-authority handles. Summaries cannot substitute for exact legislative text or approved memory. If mandatory context alone cannot fit, return a precise bounded outcome instead of truncating required identity or sending an oversized request.

Acceptance includes cases 25, 42, 71 and CW-06: long history plus large current-turn outputs; stable early constraints; prior attachment retrieval; valid provider protocol; and revoked evidence excluded after hydration. Passing a history-only unit test does not close this item.

**C. Recovery, Stop, steering, and children**

Use the existing coordinator and child interface. Demonstrate persisted plan validation before complex execution; keep simple reads on the fast path. Validate current scope, registered capabilities, dependencies, budget, and write prerequisites on the server without adding a compulsory read-only approval modal.

Run CW-01 through CW-08 and original 71–75. Include 429/Retry-After, HTTP-200 logical failure, alternating no-progress calls, legitimate retest after changed input, incomplete/malformed tool calls, browser detach/reconnect, explicit Stop, worker replacement, stale lease rejection, steering revision, revoked access, and malformed/out-of-scope child output.

Terminate only a dedicated test worker/run with an isolated fixture sink. Do not kill a shared production worker as a shortcut. Safe completed reads retain receipts; ambiguous writes reconcile; late old-goal/old-owner results cannot overwrite current state. Reconnect uses the existing run. Cancellation prevents newly admitted work while accurately reconciling operations already in flight. Child format correction remains bounded, with typed failure when it cannot recover.

**D. Narrative, JEV, and traces**

Use the existing model and source snapshot for paired comparisons. Answers should state the direct finding, why it matters to the client when relevant, what changed, an actionable next step, and material uncertainty. Use natural length; no forced five-heading template on a simple lookup. Generic questions must not require a client or unnecessary approval.

Run JEV cases 56–58 in enabled/canary and shadow modes separately. The enabled path must retrieve, revise, and recheck the affected claim within the shared budget. Preserve supported claims; do not replace repair with a blanket caveat or stream a known-wrong critical amount first. Search discovery is not proof that a primary passage was read.

Verify a real exported trace joins UI request, API, orchestrator, tool, child/JEV where applicable, proposal/receipt, and artifact. Include effective release/model/mode, selected/exposed/invoked tools, source versions, outcomes, retries, latency, usage, and known/estimated/unknown cost. Redact private text. Use existing OpenTelemetry; no new observability platform is required.

A detailed read case and an approval/recovery case should both be navigable in the current trace destination. Missing telemetry is a specific integration task, not justification for replacing the runtime.

### C4 — Complete the original evaluation without rebuilding it

Use the existing Playwright, authenticated HTTP/SSE capture, Promptfoo, deterministic predicates, and saved-output grading. Do not replace them with a new test framework. Resolve the current split between the central verifier and specialized memory/budget helpers so required cases cannot silently be unimplemented or omitted from the report.

The original 75 remains the execution list. Use these family batches after the priority slice; run each batch, fix failures, and retain its results before proceeding:

| Original IDs | Family |
| --- | --- |
| 01–12 | Memory and scope |
| 13–19 | In-Meri memory review |
| 20–27 | Budget and Program Elements |
| 28–34 | Bills and congressional direction |
| 35–39 | Opportunities and eligibility |
| 40–46 | Files and artifacts |
| 47–51 | Meetings and approved actions |
| 52–58 | Web, JEV, and narrative |
| 59–63 | Research Portfolios |
| 64–67 | Business Development |
| 68–70 | District Nexus |
| 71–75 | Bounded execution and recovery |

Keep the following obligations separate and explicit:

- Existing 26 offline cases; original 75 authenticated product cases; CD-01–CD-07; CW-01–CW-08; and applicable M01–M20. Appendix H's 26 historical JEV findings are a separate disposition list, not the offline suite.
- Standard versus Deep on 01, 20, 22, 42, 49, 51, 59 and 74 wherever actually supported. Record unsupported mode combinations; do not coerce an unavailable surface. Verify mode persistence on next turn and reload.
- Enabled/canary versus shadow JEV for 56–58. A shadow finding is not a repaired user answer.
- Repeat critical or variable cases three times as the original plan requires. Use isolated fixtures and distinct legitimate runs; regrading does not reexecute writes. Predeclare the repeat subset and report every attempt.
- Human review of every source-dependent answer: factual support, coverage/citations, client relevance, directness/clarity, actionable judgment, each 0–2. A substantive passing answer needs at least 8/10 and no zero dimension, plus all exact assertions. An AI reviewer may triage, but cannot be labeled human review.
- Existing authorized failure examples may guide repairs. No customer-recruitment program, mandatory 100-job collection delay, or automatic routing-calibration project is introduced.

Carry forward the current M applicability record. M01/M02/M06 are required now. M03–M05 and M07–M11 follow the changed source/version/delivery/narrative boundaries; M12/M13 activate when the changed existing surface edits verified drafts. M14/M15 remain later structural-drafting scope unless an existing amendment engine is changed. M16–M20 apply to the affected runtime/review/action/procedure boundaries. Preserve exact contracts and explain every applicability decision; do not mark a required case N/A for convenience.

CW-09–CW-12, new drafting DR tests, model MOD/TRN work, and broader learned-router calibration stay with their original stage or activation trigger. The original proposed 300-case calibration and 500-turn shadow requirements apply to broad learned-routing promotion, not every deterministic tool-selection repair.

### C5 — Integrated qualification and handover

1. Freeze an integrated candidate and run the relevant broader package/CI gates plus the complete required evaluation accounting. Reuse prior exact-version evidence where valid; rerun affected cases after a dependency changes. Do not repeatedly rerun all 75 for a documentation-only update.
2. Resolve remaining acceptance failures in small patches. Preserve failed runs. Target 75/75 original cases, all seven CD cases, all eight current CW cases, applicable memory cases, and required variants/repeats/human review.
3. Verify deployment and rollback using section 9. A green health check alone is insufficient. Never describe staging qualification or source presence as verified production behavior.
4. Finish the existing handover and source-adoption records. State exactly which boundaries are ready for file 02, which tests passed, which release is served, and what remains conditional or unverified.
5. Separate full file-01 completion from the original `01_READY_FOR_02` interface-readiness decision. Use that readiness label only under the original boundary contract; it is not shorthand for production deployment or 75/75 acceptance. If mandatory work remains, retain an explicit incomplete/blocked record rather than calling the whole plan finished. An accepted exception must identify the affected capability and authority; it is never counted as a passing case.

## 5. Evidence collection that stays small

Use one capture per actual run. Save the terminal response and redacted failure detail before quality assertions, including on timeout or collector error. Grade saved output with deterministic checks first, then Promptfoo and human review. Never let a grader resend an email, recreate a task, or resubmit an approval to obtain a better sample.

Reuse existing records; this field list is a reporting contract, not a demand for a new database or service:

```text
caseId / variant / repeat
fixtureHash / semanticClock / actorRole / tenant / selectedClient
checkoutSha / servedSha / imageOrWebIdentity / config / mode / effectiveModel
sourceIds / versions / passages / coverage
toolsSelected / exposed / invoked / outcomes / attempts
runId / traceId / proposalId / operationId / receipt / artifactHash
firstUsefulMs / terminalMs / tokens / knownOrEstimatedCost / unknownUsage
exactAssertions / rubric / humanReview / PASS|FAIL|BLOCKED|NOT_RUN
failureClass / reproduction / nextOwnerAction
```

Failure classes: PRODUCT, FIXTURE, HARNESS, PROVIDER, ACCESS, or DEPLOYMENT. A setup failure is BLOCKED rather than an invented model-quality failure; it still leaves acceptance incomplete. A real wrong answer or broken product action is FAIL. No answer that fails an exact assertion can pass because the prose is good.

Use authenticated browser tests for workspace behavior; use the real governed API/SSE route for non-UI factual cases. Preserve regular-user authorization. Adapter fault injection is allowed in the isolated test environment; mocking the final answer is not product acceptance. Shared environments must use their existing scoped fixture lifecycle rather than destructive blanket resets or unauthorized database shortcuts.

Track the primary outcome as correctly completed eligible jobs, with honest partial outcomes separately. Report raw counts by family, unknown usage, first useful content, completion latency, and cost per correct completed job. Include retrieval, model calls, children, retries, and JEV in the denominator.

Preserve original proposed quality/routing/latency/cost targets as targets, not achieved facts: 95% acceptable selection, no promoted family below 90%, 98% accepted-route precision, 99% required-capability recall, 98% supported material claims, zero critical unsupported claims in tested cases, no material paired accuracy regression, a 15% cost-reduction target, and at most 10% p95 latency regression where comparable samples support it. Three spot checks cannot establish a p95 or a production error rate. Do not invent a large new collection exercise for metrics whose promotion trigger is inactive.

## 6. Preserve proven-code reuse without restarting acquisition

The repository already contains donor pins, implementation work, dependencies, and notices. Reconcile `01-source-acquisition.md` and `01-source-inventory.json` against current code once; some descriptions are historical. Acquired source bytes are not adopted functionality, and retained equivalent Capiro code is not falsely labeled copied.

| Existing reuse group | Closeout action |
| --- | --- |
| H1 guardrails and H2 compaction | Retain adapted code; close the budget/context gaps with Capiro-specific tests. |
| H3 citations and H4 discovery | Map current implementation and observed consulted/exposed behavior to the original requirement; update stale adoption status. |
| H5 procedures and C&D | Preserve the executable contract and current skill/version binding; qualify CD-01–CD-07. |
| OpenAI tool-call handling | Retain compatible adapter behavior and strict completion/argument/call-ID validation; no SDK swap merely to claim reuse. |
| LibreChat approval patterns | Credit actual adoption or retain the existing equivalent with proof; in-Meri approval behavior matters, not a required code-copy count. |
| Additional Hermes durable/steering/child patterns | Validate the current native adaptation, shared authority, receipts, and recovery. Do not import process-local durability or a second scheduler. |
| Promptfoo, Playwright, OpenTelemetry | Use current compatible pinned dependencies and existing integration. |
| Retrieval examples, Firecrawl expansion, Docling, LangGraph, GovCon parsers, new compute/models | Preserve original conditional dispositions unless a measured trigger actually occurs. |

For actual new copied/adapted code, record donor URL/SHA, exact slice, license/notice, Capiro destination, behavioral change, and the regression it fixes. Keep the original Hermes pins distinct. No broad GitHub shopping, unrestricted terminal tool, ambient cloud credentials, or new personal-agent memory during closeout.

## 7. Repository deliverables and agent ownership

Maintain existing files rather than creating another parallel tracking system:

- `docs/meri/implementation/STATUS.md`: short current checkpoint, served identities, active gate, next release, suite counts, exact blocker; links to historical evidence.
- `docs/meri/implementation/01-requirements.md`: current implementation/deployment/acceptance matrix with all original IDs retained.
- `docs/meri/implementation/01-handover.md`: final interfaces, release/config/schema compatibility, run/review/artifact contracts, test evidence, rollback, conditional dispositions, and file-02 starting point.
- Existing acquisition register/inventory/notices: current actual adoption and retained-equivalent records.
- Existing eval and release directories: sanitized captures, reports, PR/test receipts, and exact deployment evidence. Do not duplicate large reports into status prose.

Record this closeout plan alongside file 01 using repository conventions. It changes execution order, not the original acceptance text. Preserve unresolved user work and historical migration/test receipts.

The lead may delegate bounded implementation or review, but remains the sole integration/deployment owner. No compulsory three-way workstream setup. A replacement agent reads these records and resumes the next gate without asking Neo to retell the history.

## 8. Concrete code entry points

Verify these paths on the implementation checkout before editing. They are navigation aids, not instructions to rewrite whole services.

| Concern | Existing entry points |
| --- | --- |
| Ordinary/research budget wiring | `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts`, `meriv3-run-budget.ts`, `meriv3-capture-provider-budget.ts`; API research budget owner |
| Prompt payload and compaction | `apps/api/src/meri/meri-compaction.helpers.ts`, `meri-context-plane.service.ts`; final orchestrator request construction |
| Memory eligibility and use | `apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts`; `apps/api/src/meri/meri-tools.service.ts`; canonical memory services |
| Plans, durable ownership, children | `apps/api/src/meri/meri-research.service.ts`, `meri-research-coordinator.ts`, `meri-research-child-task.ts`; `meriv3-plan-execution.ts` |
| Tool-call protocol and coverage | `openai-responses.client.ts`, `meriv3-assistant.service.ts`, `meriv3-turn-coverage.ts` under the orchestrator MeriV3 directory |
| Workspace continuity and reviews | `apps/web/src/components/chat/useMeriChatController.ts`, `meri-durable-research.ts`; `apps/web/src/vnext/meri/MeriApprovalsTab.tsx`, `MeriMemoryTab.tsx` |
| C&D and procedure contract | `packages/shared/src/meri-skills.ts`; `apps/api/src/meri/meri-firm-skills.helpers.ts` |
| Evaluation integration | `evals/meri/live-v1/deterministic-predicates.mjs`, `verify-capture.mjs`, `memory-row-predicates.mjs`, `grade-controlled-read-capture.mjs`, existing capture/report runners |
| Telemetry | `apps/meriv2-orchestrator/src/telemetry/meri-telemetry.runtime.ts` and existing API/web trace propagation |

## 9. Release sequence and rollback

For each increment, use current repository authority and existing deployment tooling. This planning document does not itself assert that a merge, migration, provider spend, or deployment has been authorized. Reuse standing authorization; do not repeatedly request approval for already-authorized routine work.

1. Reproduce the specific defect, patch it, and run affected deterministic/integration tests plus independent review. Include regular-role and scope/effect tests when that boundary changes.
2. Run required repository checks. Classify unrelated failures with exact evidence; do not silently waive a required gate or repair the entire monorepo in the same PR. Use an already authorized fallback build path only under its actual rules.
3. Build immutable artifacts for changed components only. Record source SHA, image digest/web identity, config/flags, effective model policy, and schema compatibility. Promote the qualified artifact rather than an untested rebuild.
4. If needed, apply an additive migration once through the existing migration owner. Rehearse on a disposable current-schema copy and prove prior-app compatibility. Do not rewrite old migration SQL/checksums, automatically mark failed migrations applied, or reset historical ledger entries.
5. Deploy backward-compatible API support before dependent orchestrator/worker/web consumers. For an orchestrator-only footer repair, do not redeploy every service. Keep one fenced worker/schedule owner and preserve run assignment.
6. Verify the actual served candidate in the permitted staging/private environment with affected `/meri` workflows and persisted receipts. Then promote under the existing internal/cohort release procedure. If live access is missing, finish the concrete candidate and report the exact remaining step.
7. Observe affected outcomes, errors, source correctness, latency, and spend using existing telemetry. Predeclare a suitable observation window/sample for the release; do not confuse elapsed time with evidence. Compare by mode and task family.
8. Retain prior compatible images/config. Roll back new admissions or the affected feature route on a hard failure; drain or preserve existing run ownership, approvals, receipts, and artifacts. Reconcile in-flight effects before any resend. Keep compatible additive schema in place.

Hard failures stop the affected rollout: tenant/client/ethical-wall disclosure; unauthorized mutation or approval bypass; duplicate committed effect; revoked-memory resurrection; execution from incomplete/invalid calls; fabricated completion; wrong critical identifier, amount, stage or deadline; or an incorrect/inaccessible delivered artifact. A single occurrence cannot be averaged away.

If an actual approval is required, prepare the tested candidate, exact artifact/config/migration list, results, and rollback first; identify the specific repository or platform rule requiring approval. Do not invent extra approval screens or process gates.

## 10. Completion and reporting contract

Every progress update should answer five questions: what user behavior now works; which SHA/PR proves the change; whether it is deployed; which acceptance cases actually passed; and the next concrete blocker/fix. Report the unchanged denominator so a partial batch cannot look like full completion.

Example format:

```text
Current gate: C2
Behavior changed: <observable user outcome>
Source / PR / served artifact: <actual identities or NOT_DEPLOYED>
Original 75: PASS n, FAIL n, BLOCKED n, NOT_RUN n
CD / CW / applicable M / mode-JEV repeats / human review: <separate counts>
Observed defect and next action: <one precise item>
File 01: incomplete | complete
File 02 boundary readiness: 01_BLOCKED | 01_READY_FOR_02, with evidence
```

Do not promise 100% precision from a finite suite. The deliverable is a demonstrably qualified foundation with exact limits and regression coverage. Full closeout requires every mandatory contract accounted for and satisfied; optional later work has an explicit disposition. If a mandatory case is blocked or failed, say so. Do not replace a hard assertion with a lower threshold to obtain a green report.

Expected user experience after qualification: Meri finds the right approved client memory; keeps approvals in the workspace; reads and delivers actual files; reports actions truthfully; handles retries and long work within limits; recovers after disconnect/worker loss; and returns concise, sourced, useful government-affairs answers with localized uncertainty. Specialist-model training and the full Congressional Drafting product remain their subsequent workstreams.

## 11. Prompt to start the lead agent

```text
Execute 01-Meri-Foundation-Closeout-Plan-2026-10-02.md in neo-capiro/capirov2.
Read the current repository instructions and original file 01 first. This is a
closeout of existing work, not authorization to rebuild Meri or redesign the eval
platform. Refresh the audited baseline, preserve other work and all original
acceptance IDs, and work sequentially through C0-C5.

Own integration and releases. Use at most one bounded implementer and one
independent reviewer/tester if useful; I do not want to coordinate parallel
workstreams. Retain working authorized agent/provider configurations. Keep the
production model configuration stable during the comparison.

Begin with the qualified coverage-footer repair and current mailbox failure,
then verify memory/approvals/files/C&D and close the budget/context/recovery
gaps. Reproduce each issue, make the smallest correct patch, run meaningful
affected checks, and verify the actual user flow. Reuse existing Playwright,
Promptfoo, capture records, budget journal, trace pipeline, and release tooling.
Ship qualified increments under existing authority; do not accumulate another
large integration PR. Preserve approvals inside /meri and the exact Commitments
& Deliverables requirements.

Keep STATUS.md concise and update the existing requirement matrix. Distinguish
implemented, merged, deployed, and accepted. Do not call the plan complete from
test counts or source presence. Continue until the original acceptance contract
is closed, or identify the exact external blocker after completing all useful
unblocked work. Any required human review or release approval must be presented
as a concrete prepared result, not another broad planning question.
```

## 12. Sources for this closeout

- [Audited current main](https://github.com/neo-capiro/capirov2/commit/723735ed1f5c562ab10e6077c67261285ea102fd).
- [Original file 01 and embedded acceptance annex](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/implementation/01-Meri-Foundation-and-Reliability.md).
- [Current checkpoint and historical evidence](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/implementation/STATUS.md).
- [Latest coverage-followup qualification](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/releases/2026-10-02/browser-coverage-followup/release-qualification.json).
- [Recorded direct-browser results](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/releases/2026-10-02/direct-browser-repairs/live-verification/browser-results.json).
- [Memory acceptance contracts and applicability](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/implementation/01-memory-strategy-acceptance.md).
- [Existing source acquisition register, including historical dispositions to reconcile](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/implementation/01-source-acquisition.md).

This plan is a new execution recommendation based on those sources. It does not claim that the remaining repairs, evaluations, merges, or deployments have already happened.
