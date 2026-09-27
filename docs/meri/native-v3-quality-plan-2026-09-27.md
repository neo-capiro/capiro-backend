# Meri native V3 quality and execution plan

**Planning document, not an implementation claim.** This repository handoff includes the [source reuse register](source-reuse-register-2026-09-27.md), the [actual 75-case contract](../../evals/meri/live-75-case-spec.md), the [evaluation agent handoff](../../evals/meri/live-75-agent-handoff.md), and a [Commitments & Deliverables acceptance extension](../../evals/meri/commitments-deliverables-extension.md). Read them together.

The source draft was based on `ae5c2b85c1266e6de4e160f2fda4155a726a7364`. Main had advanced to `d86b0662d1c6c6eb559ce2a74ea3e7244233672b` when this handoff was prepared; recheck main and deployed digests before editing or evaluating. The original baseline below remains historical.

This plan makes **native MeriV3 the single implementation path**, absorbs the useful Phase 4 requirements, and organizes the work around measurable improvements to answers, retrieval, execution, and the workspace experience.

The old Hermes-based Phase 4 is superseded as a delivery project. Its useful safety requirements remain; its runtime integration, retired tables, and signing infrastructure are not prerequisites.

This is a proposed implementation plan. It does not claim that the enhancements or acceptance runs have been completed.

## 1. Baseline and architectural decisions

The planning baseline is GitHub main at `ae5c2b85c1266e6de4e160f2fda4155a726a7364`. I verified that its source tree exactly matches `0b53603c6cc3d991f36f78b3fe21b4570d429cb9`, the baseline reviewed in your enhancement document.

Recheck main and deployed image digests when implementation begins. Repository state and running application state must be recorded separately.

Keep the existing:

- Native MeriV3 orchestrator and provider integration.
- Context Plane and authorized Capiro domain services.
- PostgreSQL, Prisma, pgvector, and tenant isolation.
- Business action proposals and approvals.
- Governed Institutional Memory and the Meri Memory tab.
- Deep Research handoff, plans, leases, and reconnect support.
- Semantic tool selector, firm skills, JEV, and existing evaluation harnesses.

Extend these components where evidence shows a gap.

The model handles investigation, synthesis, comparisons, and writing. Application code owns authorization, exact identifiers, source access, deterministic calculations, execution limits, approval enforcement, and durable outcomes.

### What a user should experience when the releases are qualified

- **Answers with direction.** For a substantive client question, Meri leads with the finding and client implication, shows the current, authorized passages and dates behind material claims, distinguishes a judgment from a verified fact, and gives a practical next action. A short question still gets a short answer.
- **Accurate source boundaries.** On a bill or budget question, Meri identifies the exact bill version, section, fiscal year and lifecycle stage. It can say which official sources it searched and where coverage is partial. It does not turn a budget request, committee proposal, remembered plan or opportunity into an enacted amount or awarded contract.
- **Useful long work within limits.** A multi-step task has a bounded plan, progress and honest partial result if time, provider availability or evidence runs out. Repeated failures stop consuming rounds; long tool traces compact without losing the selected client, prior decisions or source pointers. Deep Research can reconnect and recover safe work, subject to current authorization.
- **Visible, dependable actions.** A draft or proposal is clearly separated from a completed write. A user can review required memory or business approvals inside the Meri workspace. After approval, Meri reports a verified resulting record or an explicit unknown/failed state; a timeout does not silently create a second action.
- **Governed continuity.** Relevant approved Institutional Memory can inform the answer, including an older eligible fact. Pending, revoked or other-client facts remain excluded. Chat summaries never become approved shared memories.
- **Commitments & Deliverables.** The existing named Quick Action opens a client-scoped, read-only audit that links promises and deliverables to meeting, mail, task, document and authorized mapped Monday.com evidence when those sources are available. It flags untracked promises, missing owners/dates and coverage gaps. Creating a follow-up task is a separate approved action in Meri.
- **Correction instead of a blanket hold.** When JEV finds a fixable material claim, Meri seeks the specific missing source, revises the affected conclusion and rechecks within a bounded budget; unresolved claims remain visibly qualified.

These are acceptance outcomes, not a claim of current behavior. The plan improves the sources and capabilities already connected to Meri; it does not by itself complete every agency's budget ingestion, supply unavailable client records, grant external connector access, or establish a better specialist model. Promotion requires the actual endpoint and workspace benchmark, hard permission/write gates, and measured correct-completion, latency and cost results.

Three kinds of records must remain distinct:

| Record | What it establishes |
|---|---|
| Evidence receipt | Which authorized source/version/passage supports an answer |
| Operation record | What action was requested, approved, attempted, and observed to happen |
| Cryptographic attestation | Who signed a particular statement |

The first two are required where applicable. A separate signing system is deferred unless a concrete independent-verification requirement justifies it.

## 2. Delivery structure

Retain the enhancement plan’s Release 0–5 labels, but allow independent work to proceed in parallel.

| Package | Purpose | Main dependency |
|---|---|---|
| Deployment prerequisite | Prevent another unintended or unqualified rollout | Before any merge that could deploy |
| Release 0 | Establish reproducible baseline and failure inventory | Begins immediately |
| Release 1 | Correct outcomes, evidence, retrieval, memory, and approval behavior | Relevant baseline cases |
| Release 2 | Bound execution and make retries safe | Outcome contracts and existing authorities |
| Release 3 | Preserve long-conversation context and recover research | Context/recovery failure cases |
| Release 4 | Improve JEV correction and answer quality | Reliable evidence and human-labeled evaluations |
| Release 5 | Connect selective tools, improve playbooks, complete observability | Baseline and outcome contracts |

**Release 5’s selective-tool trials should begin after Release 0 and the first Release 1 fixes.** They need not wait for all research or JEV work.

Instrumentation starts in Release 0. Write safety starts with the first affected write. Neither should be postponed to the final release.

## 3. Deployment prerequisite: make releases controlled

The current [orchestrator workflow](https://github.com/neo-capiro/capirov2/blob/ae5c2b85c1266e6de4e160f2fda4155a726a7364/.github/workflows/meriv2-orchestrator-image.yml) combines image publication with ECS deployment on relevant main changes. Address that concrete coupling before feature merges can cause another rollout.

### Required work

1. Inventory relevant automatic image and deployment workflows.
2. Separate build/test/image publication from deployment promotion.
3. Promote an explicitly qualified immutable image digest.
4. Recheck the suspect mutable `:latest` tag, current task definitions, running digests, and service health before deployment.
5. Record the current flags and the exact configuration keys a rollout may change.
6. Abort promotion if the live configuration or image changed since qualification.
7. Record and test application rollback to the previous known-good digest.
8. Define database compatibility independently from application rollback.

Preserve the runtime retirement. Add a regression check that the candidate does not restore retired Hermes imports or depend on dropped runtime tables.

For schema changes, rehearse both:

- Installation into a fresh disposable database.
- Upgrade from supported existing histories, including the already-applied runtime retirement.

Use migration identities, checksums, resulting schema, and permission checks as evidence. A migration count such as “449 passed” is not sufficient.

There is one operating environment. Use disposable local infrastructure for destructive tests and controlled, authorized internal-tenant canaries for deployed acceptance. Do not describe those as a separate staging environment.

**Exit:** merging feature code cannot silently promote an unqualified image, and the release procedure identifies exactly what will run and how it can be rolled back.

## 4. Release 0: reproducible baseline and failure inventory

The purpose is to establish what Meri actually does today and give each subsequent change a measurable target.

### Preserve the existing offline suite

Keep the existing 26 deterministic Promptfoo cases and their report verifier. Its [contract](https://github.com/neo-capiro/capirov2/blob/ae5c2b85c1266e6de4e160f2fda4155a726a7364/evals/meri/CONTRACT.md) explicitly excludes live answers, retrieval, tools, conversation persistence, and UI.

Maintain that separation. Do not point the offline harness at production or relabel its reference answers as model-generated answers.

### Create a separate 75-task authenticated benchmark

The complete [75-case contract](../../evals/meri/live-75-case-spec.md) is supplied in this handoff. Preserve its exact case IDs, synthetic fixtures, user prompts, and observable pass conditions. Add tags for client isolation, citations, tool selection, model/mode, and UI behavior. Multiple executions of one scenario do not become additional canonical cases.

Each case must specify:

- Fixture data and version.
- Actor, tenant, client, permissions, and relevant flags.
- Request and any preceding conversation.
- Expected sources or an explicit unavailable-source condition.
- Required outcome and prohibited outcome.
- Deterministic assertions and human grading rubric.
- Expected API and workspace behavior.
- Cleanup requirements for synthetic writes.

The 75-case contract is the starting acceptance set. Supplement it with authorized real user prompts where they add coverage; keep sensitive data scoped and distinguish organic examples from synthetic fixtures.

### Record the actual behavior

Capture the candidate commit, image digest, effective provider/model/effort, mode, flags, source versions, exposed tools, executed tools, outcomes, first useful response, terminal result, latency, tokens, and cost.

Exercise UI-dependent behavior in the actual authenticated workspace: approving a proposal, opening a citation, downloading an artifact, stopping a run, reconnecting, and reloading status.

Use appropriate non-admin identities for permission tests. An administrator’s successful run does not establish ordinary-user isolation.

**Exit:** all 75 cases have explicit expectations and baseline records; material failures have reproducible evidence. Unavailable identities or fixtures remain visibly unverified.

## 5. Release 1: truthful outcomes, reliable evidence, and governed memory

Deliver this release in several small packages.

### 1A. Correct false-success behavior first

Reproduce and fix:

- Returned `{error}` objects being recorded as successful tool completion.
- Blocked, partial, or pending-approval outcomes being flattened into “done.”
- Function calls executing from incomplete provider responses.
- Invalid decoded arguments reaching execution.
- Non-successful business approval HTTP responses disappearing silently in the workspace.

Retain valid provider call/output correlation. Display approval failures with an accurate state and a safe retry path.

Do not force every operation into one generic status vocabulary:

| Operation | Required distinctions |
|---|---|
| Read | Complete, partial, failed |
| Business action | Awaiting approval, rejected/expired, executing, succeeded, failed, outcome unknown |
| Memory proposal | Submitted for review versus approved/committed |
| Research | Running, complete, partial, failed, cancelled |
| Artifact | Requested/generated versus stored, accessible, and verified |

**Acceptance:** injected failures produce the correct persisted state and user-visible message; incomplete provider output and invalid arguments cause no tool effect.

### 1B. Normalize evidence across sources

Extend the existing result envelopes and evidence ledger.

For usable evidence, preserve:

- Source identity and version/hash where available.
- Authorized tenant/client scope.
- Page, section, passage, or record locator.
- Publication, event, effective, and retrieval dates where relevant.
- Extraction state.
- Pagination, truncation, and coverage limitations.
- A stable pointer to the full authorized content.

Keep “available,” “consulted,” and “unavailable” separate. Evidence discovered but never read must not be described as consulted.

Route private/client/domain facts through authorized Capiro services. Use public search and primary-source reads for fresh external facts. Mixed questions should combine the necessary sources explicitly.

Carry evidence identity through chat, research, JEV, citations, exports, and saved artifacts.

**Acceptance:** exact-identifier cases return the correct scoped records; citations resolve to supporting content; missing evidence produces a precise limitation.

### 1C. Repair document and transcript failures

Test the existing connectors and exact-read tools before adding extraction dependencies.

Cover:

- Previous-turn attachments.
- Client documents and research attachments.
- Long documents whose relevant passage appears late.
- Tables and source locators.
- Hearing and meeting transcripts.
- Pending, partial, failed, metadata-only, and unsupported extraction.
- Attachment handoff into Deep Research.

A filename or metadata record must not count as reading the document.

**Acceptance:** answers requiring document content prove access to the relevant passage, including late passages and transcript text. Extraction gaps remain visible.

### 1D. Complete Institutional Memory integration

Preserve canonical governed memory and the existing Meri Memory tab.

Required work:

1. Test an older relevant approved fact behind more than 500 newer eligible rows.
2. If it is missed, repair candidate retrieval using appropriately scoped indexed retrieval or complete traversal. Paginating the already-capped pool does not fix the underlying miss.
3. Test direct memory search and automatic Context Plane recall separately.
4. Establish whether older or shared memory paths are reachable before changing them.
5. Ensure revoked or superseded facts cannot return through caches, summaries, projections, or research checkpoints.
6. Recheck authorization after client switches, ACL changes, and research resume.
7. Reproduce the suspected cross-client memory-key collision using identical keys under distinct clients and tenants. Treat it as a hypothesis until reproduced.

In the workspace, verify:

- Approve/reject without leaving Meri.
- Source, proposer, applicable destination, and decision status.
- Conflict and controlling-version information where needed.
- Access to six or more pending proposals.
- Persistent status after reload.
- Visible failures and safe retry.
- Reviewer and non-reviewer behavior.

Preserve existing policy distinctions: shared candidates require the applicable review process; eligible personal memory follows its existing policy. Do not introduce universal independent-review requirements that current policy does not require.

**Acceptance:** designated isolation and lifecycle cases show no unauthorized recall or mutation; shared pending candidates are not recalled as approved facts; older eligible facts remain retrievable.

### 1E. Preserve the earlier capability repairs

Requalify applicable earlier B1–B6 fixes against the current candidate:

- Client/ethical-wall filtering.
- Bounded, fail-closed scraping.
- Funding-source availability and coverage.
- Accurate evidence limitation wording.
- Legitimate delegated tool access without broadening permissions.
- Research evidence, source-qualified entities, and truncation behavior.

Do not assume those fixes survived rollback or are deployed because they passed on an older integration branch.

## 6. Release 2: bounded execution and safe writes

### Keep simple tasks simple

Retain current per-mode round/deadline limits, synthesis reserve, and provider retry/backoff.

Add missing controls where tests demonstrate a gap:

- Turn-wide tool-call ceiling.
- Repeated identical-failure breaker.
- No-progress detection.
- Cancellation propagation into tool batches.
- Input-size checks before provider requests.
- Honest partial completion when the budget expires.

Provider HTTP retries and repeated logical tool failures are different mechanisms. Avoid stacking uncontrolled retry loops.

For complex research, extend the existing plan with validated scope, source domains, dependencies, and budgets. Add typed steps only where they improve demonstrated coverage or recovery problems.

### Make write identity durable

Every affected write must have a logical operation identity established before its effect and preserved through UI retry, approval, API dispatch, and recovery.

Bind that identity to the relevant tenant/client scope, initiating request or proposal, action type, and canonical argument fingerprint.

Required behavior:

- Same identity and same intent returns the existing outcome.
- Same identity and different intent is rejected.
- A deliberately new user action gets a new identity.
- Current authorization is checked before execution and before returning protected results.

Reuse existing proposal IDs and persistence where they already provide these guarantees. A provider `call_id` is correlation; do not assume it remains stable across regenerated requests.

### Commit database effects with their outcome

For an effect wholly inside one application database, commit the mutation, resulting-object reference, and durable success record in the same transaction.

Proposal creation may precede that transaction. An atomic executor claim alone does not prove that the effect completed.

Use memory-candidate creation as the first reference implementation:

> One authorized logical request produces one candidate and a durable “submitted for review” outcome, even when requests repeat or a response is lost.

### Handle external effects explicitly

For sending, external APIs, and object storage:

- Persist intent before dispatch.
- Supply downstream idempotency keys where supported.
- Persist observed results.
- Reconcile ambiguous outcomes through durable downstream identifiers or status.
- Do not blindly retry an action that may already have happened.

Introduce an outbox only where reliable delivery across a transaction boundary requires it.

For artifacts, verify stored bytes, content metadata, access control, and retrievability before declaring completion. Reconcile partial uploads and clean up scoped orphaned objects safely.

### Required fault tests

- Concurrent identical requests.
- Response lost after commit.
- Worker failure before mutation.
- Worker failure after mutation but before reply.
- External acceptance followed by timeout.
- Approval expiration or authorization change before execution.
- Conflicting reuse of an operation identity.
- Stop racing with a write.

Cancellation stops new work and attempts to cancel in-flight work where supported. It must not claim to undo effects already committed.

**Exit:** affected write families have demonstrated duplicate protection and recovery behavior; unknown outcomes remain explicit and cannot become blind retries.

## 7. Release 3: long conversations and durable research

### Preserve context within a bounded input budget

Verify and extend existing compaction on the active V3 path.

Retain:

- User goal and selected-client scope.
- Stable constraints and decisions.
- Unresolved work.
- Material contradictions.
- Source pointers needed to reconstruct evidence.

Replace old large payloads with bounded references while preserving valid provider tool-call/output relationships. Keep full authorized source content retrievable.

Conversation summaries cannot approve memory, confer access, or resurrect revoked facts.

### Qualify existing research durability

Test the existing handoff, persisted plan, leases, and reconnect behavior before adding new checkpoint infrastructure.

Cover:

- Attachments and prior evidence at handoff.
- Full-chat clarification and Deep Research clarification separately.
- Browser disconnect and reconnect.
- Worker restart.
- Client/ACL changes and memory revocation after handoff.
- Accurate progress and terminal state after reload.

Add per-step checkpoints only when a demonstrated failure causes expensive replay or lost evidence. Resume unfinished safe reads; writes continue to use Release 2’s operation identity and reconciliation rules.

**Exit:** a 40-plus-message case preserves early constraints; tool-heavy turns stay within the declared context budget; research recovers without lost evidence or duplicated effects.

## 8. Release 4: JEV correction and useful answers

Keep three decisions separate:

| Decision | Purpose |
|---|---|
| Capability routing | Choose relevant workflows/tools |
| Passage selection | Choose potentially useful evidence |
| Claim assessment | Evaluate a material statement against evidence |

A good routing or relevance score is not proof that the answer is true.

### Qualify the existing JEV path

Verify effective configuration by tenant, surface, mode, and claim category.

Follow:

1. Disabled integration and deterministic readiness checks.
2. Paired shadow evaluation against human labels.
3. Internal allowlisted canary.
4. Measured expansion.
5. Additional specialized claim categories.

Keep factual outcomes distinct from infrastructure failures. Provider failure is not “contradicted”; missing evidence is not necessarily falsehood.

### Use targeted repair

When a material claim has a resolvable evidence problem:

1. Identify the affected claim and dependent conclusion.
2. Retrieve the specific missing evidence.
3. Revise the affected content.
4. Recheck within the remaining budget.

Start with one repair pass. Permit another only when a concrete new retrieval path exists and the budget allows it.

Where a feature promises pre-release verification, assess the protected content before streaming it. A later warning cannot retroactively verify an already-delivered claim.

Preserve supported content and precise limitations instead of defaulting to whole-answer holds.

### Improve professional usefulness

For substantial answers, consistently include the relevant parts of:

- Direct answer and client implication.
- Supporting evidence.
- Judgment distinguished from fact.
- Practical next action.
- Remaining material gaps.

Keep short requests short. Budget answers must distinguish request, authorization, committee mark, enactment, and award. Meeting preparation must use actual relationship history and transcript evidence where relevant.

**Exit:** reviewed tasks show better supported, useful completion without unacceptable latency, unnecessary holds, or avoidable clarification.

## 9. Release 5: selective tools, playbooks, and observability

This contains the original Phase 4 product goal.

### Connect selection to the served runtime

Integrate the existing selector into the actual [governed V3 path](https://github.com/neo-capiro/capirov2/blob/ae5c2b85c1266e6de4e160f2fda4155a726a7364/apps/meriv2-orchestrator/src/meri/meriv3/meriv3-retrieval-assistant.service.ts).

The initial 15–20-tool range is a tuning target, not a correctness cap.

Preserve:

- Required workflow dependencies.
- Exact readers and lookups.
- Pagination.
- Necessary clarification.
- Authorized discovery or fallback for missing capabilities.
- Research Portfolio, Federal Market, Business Development, and District Nexus coverage.

Selection must use request-local state. Two conversations must never change each other’s exposed tools.

Keep the complete registry and authorization checks on the server. Every invocation remains subject to current permissions.

Global OFF overrides tenant or surface opt-in. Rollback restores the established governed path.

### Prove actual exposure

Trace tools that were:

- Required by the workflow.
- Selected.
- Actually included in the provider request.
- Actually invoked.
- Successful, partial, failed, or blocked.

Run paired broad-versus-selected trials on the same fixtures. Promote only when coverage, quality, and safety remain acceptable.

If JEV-assisted capability routing is added, give it separate calibration, budgets, fallback, and flags. Do not reuse claim-assessment thresholds.

### Improve high-value existing playbooks

Start with:

1. **Commitments & Deliverables**, preserving existing `commitments_audit` in the Quick Action catalog and Meri workspace. It is not currently a dedicated executable firm skill. The Quick Action catalog marks it `readOnly: true`, `requiresClient: true`, and points to `query_client_changes`; that recent-change recipe and an editable prompt do not prove a complete audit. Add an explicit, versioned **read-only** firm playbook through Capiro's existing firm-skill service: inspect authorized meeting/transcript, mail, native task, action-item, document, and mapped Monday.com sources where available for the selected client; distinguish decisions, promises, proposals, and open questions; attach passage or timestamp receipts; identify explicit owners, due dates, dependencies, and deliverables; report which sources were unavailable or only partially read. Never invent a missing owner or deadline, silently duplicate an existing task, or restrict a requested full audit to a default recent window. A separately requested follow-up write uses the existing proposal, approval, and verified outcome inside the Meri workspace.
2. Client brief.
3. Budget/appropriations provenance.
4. Legislative change analysis.
5. Hearing/meeting preparation.

Keep outreach drafting as the next playbook to refine; its existing Quick Action and approval boundaries remain available. Adapt the pinned Hermes meeting-action-items and document-to-action-items skill procedures through Capiro's evidence and authorization services, as specified in the [source reuse register](source-reuse-register-2026-09-27.md). Do not duplicate Capiro's memory or task systems.

Each playbook specifies purpose, prerequisite evidence, permitted tools, output expectations, completion criteria, examples, tenant overrides, and version rollback. Use the focused [Commitments & Deliverables acceptance extension](../../evals/meri/commitments-deliverables-extension.md) alongside the fixed 75 case IDs. This extension must not replace or renumber the existing 75 cases.

“Draft outreach” must never imply “send outreach.” Quick Actions remain editable task launchers, not execution authority.

### Complete observability

Extend existing traces with operation/source IDs, outcomes, attempts, provider/model/effort, usage, cost, deadline/cancel state, JEV repair, and resulting-object references.

Keep raw private prompts, document bodies, and credentials out of default telemetry. Protect richer evaluation artifacts separately.

**Exit:** traces explain incomplete answers, prove actual selection behavior, and reconcile user-visible completion with persisted outcomes.

## 10. Evaluation and promotion gates

Maintain three separate evaluation layers:

| Layer | Purpose |
|---|---|
| 26 offline cases | Mechanism regression and grader calibration |
| 75 authenticated tasks | Initial product baseline and end-to-end diagnosis |
| Expanded routing/claim datasets | Calibration and broader promotion evidence |

The 75 tasks do not replace the older plan’s broader routing qualification or positive fixtures for advertised capabilities.

For promoted routing families, retain the planned minimum of 300 routing cases, at least 50 per promoted family, and separate development, calibration, and locked holdout sets. Expand the set when the family count requires more cases.

For broad routing promotion, retain the proposed 500 distinct representative eligible shadow turns. Synthetic fixture rows do not count as organic shadow evidence, and shadow routing must not execute duplicate tools.

Cryptographic signing of these reports is deferred. Reports must accurately disclose provenance and must not be called signed or independently attested when they are not.

### Hard acceptance requirements

All designated critical cases must show:

- No unauthorized tenant/client access or mutation.
- No approval bypass.
- No duplicate committed effect.
- No revoked-memory resurrection.
- No execution from incomplete provider output.
- No fabricated action completion.
- Correct exact identifiers, critical amounts, statuses, and deadlines.
- Artifacts that open the actual intended bytes.

Every targeted defect must have before/after evidence.

### Proposed quality and performance targets

Carry forward these targets, freezing their definitions before holdout evaluation:

- At least 95% acceptable workflow selection overall.
- No promoted family below 90%.
- At least 98% precision for routing decisions accepted without fallback.
- At least 99% recall of required capabilities.
- At least 98% supported material factual claims on reviewed references.
- Zero critical unsupported claims in the evaluated cases.
- No material accuracy regression against paired baseline cases.
- Target 15% lower total cost per correctly completed task.
- Target no more than 10% p95 latency regression.

These are proposed promotion targets, not achieved results or promises. Report fallback rates, raw counts, per-family results, uncertainty, and repeated-run variation. A small sample must not be presented as population-wide proof.

## 11. Implementation and review process

Use one integration owner and bounded parallel workstreams:

| Workstream | Responsibility |
|---|---|
| Runtime/execution | Outcomes, write safety, limits, selector integration |
| Evidence/memory/research | Retrieval, provenance, governance, context, recovery |
| Evaluation/workspace | Fixtures, independent grading, UI acceptance, release evidence |

Each PR should identify:

- Base and candidate commit.
- Affected runtime, surface, and flags.
- Reproduced problem and intended behavior.
- Existing component being extended.
- Tests and exact results.
- Relevant source, permission, and write-safety evidence.
- Observed quality/cost/latency changes, or explicitly “not yet measured.”
- Rollback procedure.

Test counts alone are insufficient. Acceptance assertions should come from agreed behavior; where fixing a bug, demonstrate the failure before the fix.

For Hermes coding assistance, preserve the requested below-50% usage limit through measurable in-flight controls, with additional token, tool-call, and spending budgets. If the relevant usage cannot be measured and enforced, use a controllable execution method. A prompt asking a worker to stay below the limit is not enforcement.

## 12. Initial implementation order

Start with these reviewable packages:

1. Deployment trigger isolation and immutable promotion procedure.
2. Baseline manifest, offline verification, and authenticated benchmark definitions.
3. False-success, incomplete-provider, and approval-error fixes.
4. First durable write slice using existing memory-candidate creation.
5. Memory isolation investigation and older-fact recall test.
6. Evidence/document corrections driven by failed baseline cases.
7. Default-off governed V3 selector integration and paired trials.
8. Turn-wide bounds, cancellation, and context-size controls.
9. Research recovery improvements where crash tests justify them.
10. JEV calibration, playbook improvements, and staged promotion.

The program is complete when the targeted improvements are implemented, independently qualified on the intended release candidate, demonstrated through the actual endpoint and workspace, and accompanied by exact release evidence and rollback instructions.

Restoring Hermes, introducing a new agent framework, building another memory system, or completing the old signing infrastructure is outside this plan unless a separately demonstrated requirement makes that work necessary.
