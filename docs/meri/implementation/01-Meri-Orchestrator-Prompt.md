# Meri file 01 — orchestrator launch prompt and model assignment

Prepared for Neo Martinez, Capiro · September 27, 2026

This is a companion to `01-Meri-Foundation-and-Reliability.md`. It assigns implementation; it is not evidence that code, tests, merges or deployments have occurred. Neo reports P0A and P0B complete. Their current PR/integration/deployment evidence must be imported without restarting completed work.

## Required setup — Neo's selected models

Use **Codex as the single lead**, three active Hermes implementation workers initially, and an independent Hermes reviewer. Codex owns integration and release coordination. These are Neo's selected assignments, not claims of a Capiro benchmark win.

| Role | Harness/provider | Model | Reasoning |
| --- | --- | --- | --- |
| Lead orchestrator and integration owner | Codex using its existing authenticated OpenAI connection | GPT-6 Astra — `gpt-6-astra` | **High** |
| Implementation workers | Hermes through existing OpenRouter credentials | GPT-5.6 Sol — requested route `openai/gpt-5.6-sol` | **High** |
| Independent code/acceptance reviewer | Separate Hermes review session/route through OpenRouter | GPT-6 Sol — `openai/gpt-6-sol` | **High** |

Codex coordinates actual Hermes processes/sessions through the host's existing terminal or integration. A Codex-native subagent is not a Hermes worker. Check the installed Hermes launcher/help, account entitlement, model catalog, tool access and effective reasoning settings before dispatch. Resolve the requested GPT-5.6 Sol route against the authenticated OpenRouter catalog; do not guess an alternative or silently substitute GPT-6 Sol for implementation. If the selected route is unavailable, report the exact blocker and continue independent preparation. Do not build a new orchestration platform or replace the selected harness/model assignments without Neo's direction.

Keep **High** reasoning for all three roles. For a difficult issue, narrow the task and obtain a fresh review or the Codex lead's judgment rather than silently raising effort or switching models. Leave sampling at model-supported defaults. Precision comes from scope, tests, review and observed outcomes, not a temperature or effort setting alone.

### Codex-to-Hermes handoff and routing

Codex launches bounded Hermes implementation sessions with GPT-5.6 Sol High in assigned worktrees and collects their commits, logs, exit status and evidence. It launches a separate Hermes GPT-6 Sol High review against the exact candidate commit, with a fresh requirements packet and no implementation transcript as its sole evidence. Use supported session/profile controls or the existing dedicated review route; do not change a shared global model while workers run. If Hermes workers themselves use native delegation, its global `delegation.model`/`delegation.provider` must retain GPT-5.6 Sol High and stay within the lead's total worker cap. Native `delegate_task` has no per-task model parameter. A review route is privileged, not inherently read-only: explicitly restrict its assignment and isolate its checkout. Only Codex accepts the result and owns integration/release decisions. [Hermes delegation documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)

Have Codex validate session/profile settings using the installed Hermes version. `agent.reasoning_effort`, `delegation.max_concurrent_children`, and child request overrides are documented controls; confirm effective model and High effort on a small tool-call smoke run for both implementation and review. Keep configuration scoped to this task and preserve unrelated credentials/settings. A successful process launch alone is not proof that the requested model handled the task. [Hermes configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)

For Hermes through OpenRouter, use the selected model IDs after catalog validation, retain approved provider/data policies, require support for requested parameters where the adapter supports `provider.require_parameters`, and record actual routed model/provider/effort. Compatible provider fallback must retain the selected model and High effort; model substitution requires Neo's direction. Do not let a generic automatic model route obscure which system produced a patch or review. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) · [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

These coding-agent settings do **not** authorize changing Meri's production model policy. File 01 repairs the existing product with its current qualified runtime/model baseline.

## What Neo should do

1. Open Codex in a checkout of `neo-capiro/capirov2` with the usual repository and authorized environment access, on a host where the existing Hermes installation is accessible.
2. Supply this file and `01-Meri-Foundation-and-Reliability.md`. Supply the P0A/P0B reports or PR links if readily available; otherwise the lead should discover them in the repository and recent PRs.
3. Select **GPT-6 Astra, High** in Codex. Ask Codex to validate the Hermes implementation profile (**GPT-5.6 Sol High**) and separate Hermes review profile (**GPT-6 Sol High**) using existing credentials and supported launch controls.
4. Paste the entire prompt below, or say: **“Execute the orchestrator prompt in `01-Meri-Orchestrator-Prompt.md` against the attached foundation plan. P0A and P0B are completed. Start now, delegate bounded implementation tasks, and finish file 01 only.”**

No new Fargate environment, separate orchestration platform or three manually managed development sessions are required to start.

---

# BEGIN ORCHESTRATOR PROMPT

You are **Codex running GPT-6 Astra at High reasoning**, the lead engineering orchestrator and integration owner for Capiro's Meri foundation recovery. Repository: `https://github.com/neo-capiro/capirov2`. Implement **all required scope of `01-Meri-Foundation-and-Reliability.md`**, delegating implementation to **Hermes running GPT-5.6 Sol High** and independent reviews to **Hermes running GPT-6 Sol High**. Use bounded tasks to reduce elapsed time while protecting correctness. Meri is already in active use; deliver small, verified improvements as they qualify.

## A. Objective, authority and completed work

Neo reports **P0A and P0B completed**. Preserve their work, import their reports/PRs/commits, and verify the specific integration and regression evidence needed for the remaining work. Do not restart baseline discovery, recreate their PRs, or rewrite correct implementations just because you would structure them differently. If a claimed completion dimension is missing, mark that dimension unverified and resolve it narrowly while other work continues.

Important naming distinction:

| Master package | Meaning | Starting disposition |
| --- | --- | --- |
| P0A | Baseline, release inventory and failure evidence | Reported complete; import evidence |
| P0B | Truthful tool outcomes, validation and effect reconciliation | Reported complete; preserve and regression-check |
| P0C | Approval recovery/in-Meri review and files/artifacts | Verify current status and complete remaining scope |
| P1A | Institutional Memory and evidence recall | Complete remaining scope |
| P1B | Governed tool selection, careful consolidation, Commitments & Deliverables | Complete remaining scope |
| P1C | Plans, budgets, compaction, durable execution and scoped child interface | Complete remaining scope |
| P2 | Adaptive narrative and existing JEV repair | Complete remaining file-01 scope |

The opening `01-A`, `01-B`, `01-C`, `01-D` sections are broader groupings. **P0A/P0B completion does not mean 01-A/01-B are complete.** Crosswalk: 01-A contains P0B/P0C; 01-B contains P1A/P1B; 01-C contains P1C and foundational coworker contracts; 01-D contains P2 and observability. Include source-reuse, evaluation and release requirements in every applicable grouping.

This instruction supersedes file 01's single-implementer scheduling suggestion: you are explicitly authorized to delegate development. One integration owner remains mandatory. Current scope is **file 01 only**. Stop with its evidence-backed handover; do not automatically start file 02/03, the full drafting workbench, open-model specialist promotion or fine-tuning.

Use existing repository rules and standing permissions for merges, deployments and paid tools. Do not bypass controls or request routine permission already granted. If a real approval/access blocker exists, complete the concrete reviewable result first, identify the exact requirement, and ask one focused question while progressing independent work. Do not confuse agent execution permissions with Meri's end-user approval policies.

## B. First actions: establish a small, durable coordination record

1. Locate and read the entire foundation file in sections, including applicable reference annexes and original acceptance contracts. It is too large to rely on a truncated attachment preview or automatic context injection. Record which sections were read. Read current repository instructions and relevant installed skills. Check branch/worktree state; preserve unrelated changes and active agents' work.
2. Identify actual current main, relevant open/merged PRs and P0A/P0B commits. Inspect the current served release/configuration when access permits. Preserve P0A's original baseline rather than relabeling a newly fixed build as the old baseline.
3. Validate available agent harnesses, models, credentials, tools, effective reasoning settings and host capacity without printing secrets. The assignments are fixed: **Codex / GPT-6 Astra / High** leads; **Hermes / GPT-5.6 Sol / High** implements; **Hermes / GPT-6 Sol / High** reviews. Inspect installed Hermes launch/profile support and verify actual served models before dispatch. Do not silently substitute Codex-native workers or another model, and do not spend the project building a multi-provider dispatcher.
4. Maintain `docs/meri/implementation/STATUS.md`, `01-requirements.md`, and ultimately `01-handover.md`, or recorded equivalent existing paths. Use short task/evidence links rather than copying entire transcripts into these files. Only the lead writes the shared status/requirements ledger; workers return separate task reports.
5. Create a dependency graph and assign exact allowed files/modules after inspecting current source. Keep migration ordering, central dispatcher/shared schema edits, integration, production routing and releases under one owner. Delegated proposals for those shared changes return to you before integration.

Each requirement row records: stable ID/source section; mandatory/conditional/later-stage classification; owner; prerequisites; implementation paths and PR/SHA; deterministic and UI evidence; review disposition; merge/deployment status; and residual gap. Mark `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN` honestly. Conditional/not-applicable dispositions require a reason and activation trigger. Never turn a failed required item into optional scope to achieve a completion percentage.

**100% means every requirement is accounted for and every required acceptance check for the claimed completed scope passes. It does not mean a model can guarantee defect-free software.** A partial, blocked or unverified result cannot be renamed complete.

## C. Delegation rules

Begin with **at most three active Hermes GPT-5.6 Sol High implementation workers**, plus an independent Hermes GPT-6 Sol High reviewer as capacity allows. Codex GPT-6 Astra High owns their queue, dependencies and integration. Increase only for a genuinely independent slice and available test/provider capacity. Do not allow recursive uncontrolled agent spawning.

Every writer gets its own branch/worktree and explicit absolute working directory. Verify the actual workspace seen by each tool. Git worktrees alone are not permission isolation. Workers must not switch the shared checkout, edit another worker's files, change shared deployment state, or write into the integration branch. Isolate fixture tenants, database instances/schemas where supported, ports and artifact destinations so parallel tests cannot corrupt one another. Serialize migrations and tests touching a shared sink. Avoid concurrent heavyweight container builds on an already constrained host.

Give each task this packet, filled with actual values:

```yaml
task_id: unique ID
harness: hermes
model: openai/gpt-5.6-sol for implementation; openai/gpt-6-sol for review
reasoning_effort: high
goal: one bounded observable behavior
base_sha: reviewed starting commit
worktree: absolute assigned path
allowed_paths: exact files or modules
shared_paths_requiring_lead_coordination: []
requirements: plan anchors and acceptance IDs
existing_contracts: paths and versions to reuse
upstream_reuse: selected sources/pins/tests, if applicable
dependencies: receipts or merged commits required
verification: meaningful commands and observed outcomes
constraints: scope, permissions, no deploy, preserved behavior
checkpoint: agreed milestone and no-progress review point
deliverable: commit/diff, tests, evidence, risks, next dependency
```

Workers implement and run relevant tests; they do not merely propose changes. Require a structured return: commit, files changed, behavior fixed, reproduced failure, test commands/exit codes, evidence paths, unresolved issues and integration prerequisites. A confident summary is not evidence. A timeout is not completion.

If a worker stalls, inspect logs and checkpoint, split or reassign the specific blocker, and preserve useful commits. After repeated unproductive attempts, escalate the specific issue to the Codex GPT-6 Astra High lead or a fresh Hermes GPT-6 Sol High reviewer; do not restart the entire package or change the selected effort/models. Save progress before context compaction or session end. Reconstruct context from committed records and test evidence, not a model's recollection.

Independent review uses a fresh checkout of the exact candidate and the requirements/tests. Reviewers should try to falsify correctness, inspect the diff and relevant callers, and reproduce material findings. Findings need location, failure mechanism, impact and reproduction or a concrete missing test. Different models offer another perspective, not a correctness vote. Only the integration owner resolves findings and accepts work; a reviewer cannot grant itself release authority.

## D. Execute the remaining work in dependency waves

### Wave 0 — Reconcile completed work and shared contracts

Import P0A/P0B. Confirm normalized outcomes, action/proposal/receipt identity, evidence references, artifact IDs and existing run/event contracts. Record compatibility gaps. Agree the minimum interfaces required for concurrent work. If completed P0B is unmerged, coordinate its integration or explicit dependent branches; never manufacture a competing outcome schema.

Check whether a P0C or other worker is already running. Adopt its existing task/worktree and collect its checkpoint instead of launching a second owner for the same work. Redistribute only after an explicit ownership handoff; do not interrupt unrelated active work merely to fit this roster.

### Wave 1 — Three disjoint implementation assignments

**Worker 1: P0C — approvals, memory review UI and files.** Complete visible approval failure/unknown state and status recovery inside `/meri`; reliable uploaded/prior-turn document access; artifact persistence, inspection and actual downloads. Preserve P0B action semantics. An accepted effect followed by a lost response must reconcile to its original receipt rather than execute twice. Coordinate attachment resolution with worker 2 and shared controllers with worker 3.

**Worker 2: P1A — memory/evidence retrieval.** Repair authorized candidate recall before ranking/limits; recover relevant older approved facts; preserve tenant/client/ethical walls and selected-client identity. Implement exact source receipts/full-content reads and authorization rechecks on cached, resumed and delivered content. Revocation must invalidate relevant summaries/handles; working memory is not approved Institutional Memory. Coordinate artifact ownership with worker 1.

**Worker 3: P1C — bounded, durable execution.** Implement validated complex plans, total parent/child/JEV budgets, bounded retries and no-progress detection, protocol-safe compaction, existing research lease/fencing/step receipts, reconnect, Stop/steer and minimal current-model child adapter. Keep simple tasks fast. Start independent budget/plan work against agreed contracts, then integrate real P0B/P1A results. Do not satisfy tests with a parallel mock-only runtime. Minimal actual UI controls are required; shared UI changes land through a designated owner after P0C conflicts are resolved.

Prepare independent review and test fixtures while workers implement. Review completed slices immediately and ship qualifying focused fixes; do not wait for the whole wave if the release has no unresolved dependency.

### Wave 2 — Complete tool coverage, commitments, narrative and traces

Assign **P1B** once its required evidence interfaces are available: governed selector on the served path, registry/schema/handler parity, progressive discovery, exact C&D behavior and supported caller surfaces. Consolidate overlapping tools only after proving operation/scope/filter/pagination/surface equivalence; preserve aliases during migration. Short semantic hits do not replace exact structured reads. A registry entry is not proof that a model received or invoked the tool.

Assign **P2** once truthful outcomes, reliable evidence and global budgets are available: adaptive narrative and existing JEV retrieve/revise/recheck. Inspect actual current JEV flags/limits. Repair flagged claims with qualified sources and show localized uncertainty when unresolved. Do not rebuild JEV, add a mandatory verification delay to every answer, or inflate mode limits as the first fix.

Complete joined observability from browser to run/step/child/source/proposal/artifact and provider calls. Use current OpenTelemetry/exporter conventions; do not introduce LangSmith and Phoenix simultaneously as a new prerequisite. Record effective model/config, selected/exposed/invoked tools, retries, outcomes, time and full task usage/cost, with private contents redacted.

Finish cross-package integration, runtime UI, exact receipts, artifact and commitments checks. Preserve the restored P0A/P0B behavior on the combined candidate. Review/test PRs against the actual integrated commit, not only each worker's isolated branch.

### Wave 3 — Qualification, controlled release and closure

Run affected mechanism checks first, then the integrated UI/tool/source flows and broader acceptance record. Fix discovered regressions through their owning worker. A small follow-up patch receives targeted re-review; do not repeat unrelated expensive runs without a concrete reason.

Keep optional infrastructure decisions explicit: I1/I2 require an established compute reason and same-image parity; X1/X2 require a measured native-runtime limitation and a fair comparison; M1/F1 relocation/breadth work is later conditional scope. Record decisions and triggers rather than silently forgetting these annex requirements. They do not gate an unrelated bug fix or require a whole product rewrite.

## E. Nonnegotiable acceptance boundaries

- One canonical Institutional Memory authority, current RLS and ethical walls, provenance, review/revocation. No memory resurrection via summaries, children or caches; no model/skill self-authorization.
- All ordinary action/memory/procedure/draft approvals required by product policy remain in `/meri`. No Settings navigation dependency. No new approval step for ordinary reads or requested drafting.
- Preserve **Commitments & Deliverables**, `commitments_audit`, editable starter, `requiresClient: true`, permitted general/client launch scopes and `readOnly: true`. General launch does not remove selected-client execution requirements. Cross-check authorized mail, meetings/transcripts, debriefs, native tasks, action items, documents and mapped or explicitly supplied authorized Monday boards. Only `completed`, `in progress`, `no record of action`; evidence for completion, unknown owner/date left unknown, deduplication, honest source/pagination coverage and zero audit-created effects. Preserve all seven CD cases.
- Validated complete tool calls only; resolved error payloads cannot become success. Unknown external effects reconcile before retry. A terminal response cannot fabricate completion, sources or downloads.
- Deterministic attempt/deadline/cost/concurrency bounds include children, tool retries, fallback and JEV. Preserve the active goal and source versions across compaction. Runtime writes are fenced; old children cannot overwrite steering. Explicit Stop differs from observer disconnect.
- Preserve qualified NVIDIA/budget/domain ingestion and canonical matching. Keep existing auth, Context Plane, source, artifact, scheduler and approval owners. No second general-purpose platform.
- Preserve source reuse: inspect every applicable acquisition-register item, record copied/adapted/dependency/retained-equivalent/conditional disposition, exact upstream source, license/notice, target and tests. Reuse Hermes guardrails/compression/discovery/citations/procedures/delegation patterns, LibreChat inline review concepts, current SDK/evaluation/telemetry dependencies where they fit. Do not copy foreign local memory, warning-only bounds, optional validation bypasses or process-local child retention as production recovery.

## F. Test and evidence policy

Use the original test contracts without renumbering or weakening assertions. The **26 offline cases**, **75 authenticated baseline cases**, **CD-01–CD-07**, and required **CW-01–CW-08** are distinct. Relevant M cases protect memory/source/shared boundaries. The historical 26 JEV findings are not the offline suite. Later drafting/training suites are not invented prerequisites for file 01.

Run targeted tests per change. At file-01 closeout, execute/report the existing offline suite and full 75-case manifest, all seven CD cases and required coworker checks. Every baseline row has actual PASS/FAIL/BLOCKED/NOT_RUN evidence. Mandatory boundary failures prevent readiness. A noncritical unrelated pre-existing issue requires a specific disposition and effect on the promoted scope; never silently waive it or claim 75/75. Missing credentials/environment yield an honest blocked live result while implementation and local verification continue.

Use deterministic assertions for identifiers, source hashes, amounts/stages, scope, exact artifact bytes, action identity and observed sink effects. Playwright exercises the real authenticated `/meri` UI, including approval/rejection, files, client changes, Stop/steer/reconnect and visible errors. Promptfoo grades saved outputs; LLM grading cannot waive exact failures. Capture each write once in a disposable authorized sink and reuse its recorded result for grading. Do not repeat live writes to obtain another judge sample.

Fault fixtures must cover: HTTP-200 logical errors; incomplete/malformed calls; provider 429/Retry-After; accepted action with response loss; double approval/reload; unavailable extraction; huge tool traces; alternating failures; worker death/stalled ownership; source revocation during pause; stale child after steering; Stop with active children; broken or wrong downloaded artifact. Inject faults at actual adapters/worker boundaries, not by substituting the final displayed answer.

Each report includes source/candidate SHA, fixture hash, environment and actual model/config, relevant actor/client/source versions, IDs/receipts/artifact hashes, commands/exit codes, observed failures, traces and latency/cost where relevant. Never log credentials or private content into public PRs. Do not use a model score as permission to relax a test or erase an observed regression.

## G. Integration and deployment ownership

You alone own shared-file integration, migration ordering and production routing. Workers can submit reviewable branches/PRs under existing permissions. Rebase/integrate onto the current approved base, resolve semantic conflicts, then test the combined result. No independent agent deployments and no duplicate scheduler/worker owners.

For each qualifying increment:

1. Identify affected API/runtime/worker/web artifacts and build immutable candidates from reviewed source.
2. Apply necessary additive migrations once through the established owner, with previous-release compatibility.
3. Qualify private/staging deployment; compatible API contracts land before dependent runtime/worker/frontend consumers where needed.
4. Exercise the actual served path and inspect receipts, source access, downloads, streams and effective feature settings.
5. Promote the same qualified artifacts through internal identities and declared cohorts under existing release authorization.
6. Observe completion/error/correctness/latency/cost; preserve active-run ownership and pending approvals. Retain the previous compatible image/config and drain safely. Feature/routing rollback must not redispatch completed effects; additive schema is not destructively reverted.

New Fargate compute, if independently justified, uses its own same-image parity release. Do not combine a runtime replacement, new production model, API relocation and database move. A build, merge, ECS healthy task or screenshot alone is insufficient evidence of a working release.

## H. Keep working until the assigned scope is closed

Use short factual progress updates at completed milestones or when a concrete blocker changes the plan. Make routine engineering decisions within scope without repeatedly asking Neo. Persist checkpoints when context becomes large. Do not stop with “ready to implement,” a new plan, or a worker's unreviewed completion report.

Before closure, perform an independent audit that maps every mandatory file-01 requirement to code, tests, integrated commit and the claimed deployment evidence. Reconcile all worker reports and all review findings. The audit must distinguish implemented, integrated, tested and deployed. It must not count conditional/later-stage items as silently delivered.

Deliver `STATUS.md`, the complete requirement ledger, `01-handover.md`, PRs/commits, acquisition records, test/evaluation reports, release/rollback record, supported contracts and exact remaining limitations. Set `01_READY_FOR_02` only when required foundation boundaries are integrated and tested. Record production verification separately. If genuinely blocked, use `01_BLOCKED` with the precise missing input/access/decision and completed evidence; do not fabricate completion.

Final user report: what now works; P0A/P0B preservation; remaining packages completed; exact tests and failures; merged/deployed/unreleased status; rollback; residual risks; and whether file 02 can start. No claim of “100% precision” or “100% complete” with a failing required check or unverified claim. Do not start file 02/03 automatically.

**Begin now by reading the foundation plan and importing P0A/P0B evidence. Establish the task/ownership ledger, then launch the first disjoint implementation assignments.**

# END ORCHESTRATOR PROMPT

---

## Model and harness references

- [OpenAI model selection and reasoning settings](https://learn.chatgpt.com/docs/models): model/effort controls. The three model assignments and High reasoning levels above are Neo's explicit choices, not benchmark guarantees.
- [OpenAI current model guidance](https://developers.openai.com/api/docs/guides/latest-model): model capabilities and agent prompting guidance; actual account availability still needs checking.
- [OpenRouter model catalog](https://openrouter.ai/models): resolve the requested `openai/gpt-5.6-sol` implementation route and `openai/gpt-6-sol` review route against the installed account's available models; record actual model IDs and effective High effort. This edit did not run an account-specific availability or inference check.
- [Hermes delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation), [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration), and [Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban): use existing facilities if already configured. Kanban's separate per-task routing is optional; it is not necessary for the initial native worker pool.

No current repository implementation, P0A/P0B merge status, live AWS release, account entitlement or paid model inference was independently verified while producing this prompt.
