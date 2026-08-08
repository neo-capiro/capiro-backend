# Outreach V3 Revised Phase 2 — Independent Validation

## Required reviewer posture

Use a reviewer/context that did not implement the Phase 2 branch.

Do not accept source assertions in place of execution. Do not modify code before reporting findings; first return the review verdict/findings against the exact reviewed SHA.

## Required inputs

1. exact Phase 2 branch/head;
2. Revised Phase 2 executable plan;
3. Phase 2 input lock/owner override;
4. Phase 2 Campaign State, command and event contracts;
5. Phase 2 findings ledger;
6. actual DB-free evidence;
7. actual disposable-DB evidence;
8. actual real state-flow evidence;
9. Phase 3 regression evidence;
10. current complete diff against the recorded Phase 2 base.

## Required commands

On the exact clean head:

```bash
pnpm install --frozen-lockfile
pnpm verify:outreach-v3-phase-2
pnpm verify:outreach-v3-phase-2:db
pnpm verify:outreach-v3-phase-2:local -- --sha "$(git rev-parse HEAD)"
pnpm verify:engagement-phase-3

git diff --check
git status --short
```

The owner-directed browser acceptance policy is:

```text
localhost Clerk/browser acceptance is not authoritative
browser acceptance is against the deployed Capiro application
```

Do not rewrite a historical localhost BLOCKED result as PASS. Phase 2's disposable database/state-flow runner is still valid engineering acceptance; it is not a substitute claim that a local Clerk browser ran.

## Architecture inspection

Confirm:

- Campaign Spec/state versions are canonical truth;
- no conversation/model state is canonical campaign truth;
- no final V3 UI;
- no OpenAI Responses API or SDK dependency;
- no LangGraph/general LangChain agent;
- no new Outreach service;
- V3 state module only in `engagement-api`;
- main API does not expose the V3 state routes;
- V3 state flag defaults disabled and fails closed;
- current web has no V3 state dependency;
- Outreach v2 remains isolated;
- reducers are pure;
- future commands have no reducer authority;
- proposal Apply is explicit;
- hidden reasoning has no persistence field.

## Database inspection

Confirm migration is additive only and contains no legacy Outreach mutation/backfill.

Inspect/prove:

- four isolated tables;
- tenant/user FKs;
- `(session_id, tenant_id)` child/session binding;
- state-version uniqueness;
- event-sequence uniqueness;
- command-batch idempotency uniqueness;
- RLS enabled/forced;
- runtime grants narrowed;
- state/event append-only triggers;
- proposal content/terminal immutability;
- valid proposal decision-shape checks;
- no destructive routine rollback requirement.

Inspect the disposable DB evidence for both fresh and ordered-upgrade paths and confirm a real legacy `outreach_records` sentinel remains unchanged.

## Command/concurrency inspection

Confirm:

- expectedStateVersion required on every command batch;
- owner session lock occurs before idempotency/version checks;
- idempotent retry is checked before stale-version rejection;
- changed payload under reused batch ID rejects;
- invalid command anywhere in batch produces no partial state write;
- changed batch creates one state version;
- no-op creates no state version;
- restore always creates a new state version;
- exactly one concurrent same-version writer wins;
- sponsor references reauthorize within the state transaction;
- one denied sponsor client fails the whole command.

## Proposal inspection

Confirm:

- proposal create != state mutation;
- proposal source is server-owned/user in Phase 2;
- commands are strict/normalized/hash-bound;
- explicit Apply only;
- Apply uses same authoritative command engine;
- Apply uses a server-owned mutation batch UUID, not user-controlled proposal/batch collision identity;
- Apply/state/proposal terminal stamp are atomic;
- stale proposal cannot auto-rebase;
- competing old-version proposals supersede;
- superseded Apply returns deterministic stale conflict;
- terminal proposal content/status cannot be rewritten.

## Mandatory negative controls

Every item must be actively rehearsed or mechanically demonstrated to fail:

```text
NC-1   make session require client
NC-2   same-tenant other user reads owner's session
NC-3   other tenant commands session
NC-4   stale expected version overwrites current state
NC-5   invalid command in middle partially applies batch
NC-6   same batch ID + changed normalized payload succeeds
NC-7   UPDATE immutable state version succeeds
NC-8   DELETE immutable event succeeds
NC-9   proposal creation automatically mutates state
NC-10  stale/superseded proposal applies or rebases
NC-11  one denied sponsor client partially persists authorized clients
NC-12  SEND_EMAIL_NOW/equivalent direct send command appears
NC-13  future generation command invokes provider/LLM
NC-14  V3 state operation writes OutreachRecord/draft/job/send tables
NC-15  reducer imports Prisma/capability/provider runtime
NC-16  persisted wizardStep/currentStage appears
NC-17  reasoning/chain-of-thought field appears in state/event/proposal
NC-18  OpenAI/LangGraph/general LangChain dependency appears
NC-19  V3 state routes appear on current main API unexpectedly
NC-20  feature disabled but V3 state route mutates/returns functional response
```

Also rehearse:

```text
NC-21  child tenant_id mismatches its session tenant_id
NC-22  proposal command payload rewritten during decision
NC-23  terminal proposal rewritten
NC-24  direct user-chosen batch ID pre-consumes proposal Apply identity
NC-25  locale/ICU ordering changes equivalent Campaign Spec hash
```

## No-dual-write / no-external-action inspection

The real state-flow acceptance must show before/after digests unchanged for:

```text
outreach_records
outreach_draft_artifacts
outreach_draft_versions
outreach_jobs
outreach_job_items
outreach_send_intents
outreach_deliveries
engagement_connections
meeting_bot_sessions
```

Source/dependency inspection must show no Phase 2 LLM, mail, OAuth, Recall, sync, S3/client-document external-action path.

## Findings rule

Classify findings as:

```text
P0
P1
blocking P2
non-blocking P2
Phase 1 regression
Phase 3 regression
test/harness defect
future-phase request
environment/authorization blocker
```

Do not solve a Phase 2 defect by introducing reasoning, target/context intelligence, generation/send, final UI, canonical cutover, or a new service.

## Exit

Approve only when:

```text
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
DB-free = PASS
Disposable DB = PASS
Real state flow = PASS
Phase 3 regression = PASS
mandatory negative controls = PASS
working tree = clean
```

Required exact approval token:

```text
OUTREACH_V3_PHASE2_APPROVED
```

Otherwise return:

```text
OUTREACH_V3_PHASE2_REJECTED
```

with findings and evidence paths.
