# Objective → Strategy → Planner source integration checklist

This checklist distinguishes implemented source from missing composition and
from runtime qualification. It is a successor to PR51, not a new release
candidate. First-chat source, image pins, runtime bindings and deployment remain
with their existing owners.

## Inspected source

| Repository | Exact inspected source | Scope |
| --- | --- | --- |
| Backend | [PR51](https://github.com/neo-capiro/capiro-backend/pull/51), `81dd0313760c0f18858cb8aa2ad73191da71f138`, tree `81a3ea3ed95bdaf2410301a922cf4431acece7d7` | Parent of this isolated successor; PR50 remains at `5591eac08428635bf911a0aa32acea859e2a5d95`. |
| Backend Objective contracts | [PR42](https://github.com/neo-capiro/capiro-backend/pull/42), `6d24414da975b52ab9802a883b22c868ad14fc92` | Included through PR49/50/51; durable issuance and signed Meri contract source already exist. |
| Frontend Objective receiving | [PR58](https://github.com/neo-capiro/capiro-frontend/pull/58), `4e1421054df0d32c564f7c9bc75cbd5e5366b428` | Existing Planner draft/Objective receiving source; it does not claim the newer governed flow. |
| Frontend later inspected context | [PR62](https://github.com/neo-capiro/capiro-frontend/pull/62), `9e6d80843b0a46a862f7613b4ab9b08d925d7b17` | This PR adds personal Meri preferences. Its seven inspected inherited Objective-flow blobs match local source `056b562694df7bbca4a45aef1221d9a3a12bf057`; whole-tree equality was not assumed. The frontend owner independently confirmed the legacy/governed distinction below. |
| Meri ordinary/read stack | [PR109](https://github.com/neo-capiro/meri-greenfield/pull/109), `b4daa4adf6e8269e7c341751db9a02bf6d4f062b` | Typed Objective modules exist; several real composition seams remain unconnected. |
| Meri later read successor | [PR110](https://github.com/neo-capiro/meri-greenfield/pull/110), `f7f4ed5b397fcd44576251739ed361aee6941d7a` | Verified one commit after PR109; its 42 changed paths do not change the Objective composition paths named below. Shared read-credential changes are not assumed to qualify Objective execution. |
| Meri Objective RS256 receiver | [PR95](https://github.com/neo-capiro/meri-greenfield/pull/95), `5781c1150fbb3954c25ba245b26d325e06b4d82d` | Divergent source: PR109 is 29 commits ahead and one behind at merge base `d27c807…`; it still contains the older EdDSA receiver. PR95 is not implicitly included in PR109. |

The original reconciliation at backend
`da1fd7b173410c7c37d6c520a807240eb2511ab3` was reread in full: README,
INCREMENTAL-PLAN and GOVERNMENT-COVERAGE. Its unimplemented-work statements are
historical inputs, not evidence that later source is absent.

Backend paths below are repository-relative. Frontend and Meri paths refer to
their respective repository rows above. “Built” does not mean activated.

## User-flow integration

| Step | Built source | Missing implementation or integration |
| --- | --- | --- |
| Save and confirm a ready Objective | Core `apps/api/src/clients/objectives/objectives.service.ts`, `objective-work-intent.ts` and `objective-canonical-plan.ts` append the exact ready revision/intent and reserve stable canonical targets atomically. Frontend `ObjectiveEditorControls.tsx` and `writer.ts` save edits before `confirm_ready`. | The intent remains inert. A ready revision alone supplies no reviewed Strategy type; the existing explicit UI selection must enter a durable, authorized canonical request rather than be replaced by an invented default. No mounted ready-intent dispatcher was found. |
| Admit current human/client/source authority | `ObjectiveWorkService` uses the actual request-local application authority, current native membership/client/memory-wall admission, Objective revision, source/control locks and release rechecks. Ordinary Strategy client permissions have their existing canonical destination readers. | Production HTTP/session qualification remains separate. These reads do not authenticate a background workload or authorize a model invocation. |
| Ground in client/government/relationship context | Core `objective-generation-context.service.ts`, `objective-generation-background.ts`, `objective-generation-typed-context.ts` and `strategy-context-plane.service.ts` retain source/version/as-of, required inventory, authorized Directory/relationship/history observations, typed context and coverage hashes. General prompts policy-omit EIN. | Rich required records still fail closed at packet budgets; the generic history projection still exposes outreach summaries and mail snippets rather than all potentially critical body/recipient/thread evidence. A reviewed authorized reference/window contract for those larger required inputs remains work; “all context” is not established by an enumeration-complete flag. |
| Obtain native command CAS values | This successor adds the authorized generation GET `requestedSource` projection, from the actual canonical state, with ready revision and binding version. Current Objective revision remains separate. | Frontend has no governed generation GET consumer yet. Objective version must not substitute for canonical binding version. The projection is an observation, not permission to retry. |
| Approve Strategy and Planner work explicitly | `objective-work.controller.ts`, `objective-work-command.ts` and `ObjectiveWorkService` implement commands, atomic pair confirmation, immutable consents/receipts, exact replay/conflict, fresh policy and compare-and-swap. The concrete Planner owner is mounted. | `ObjectiveWorkModule` currently binds only `ObjectivePlannerWorkOwner`; it explicitly refuses `objective.strategy.draft`. Native Strategy accounting/absence/policy ownership is a real source gap. Adding a frontend `confirm-pair` call alone cannot complete this step. |
| Create a durable canonical generation | `draft-job.service.ts` already supports explicit actor/request-scoped Objective jobs. Canonical producer admission, request publication, acceptance, completion and terminal ledgers exist under `apps/api-strategy/src/meri/objective-canonical-*`. The legacy worker excludes canonical jobs. | The present frontend submits the separate legacy Objective job path. It neither issues native action consent nor enters the protected canonical admission/acceptance path. A durable chosen-type/request entry and genuine issuer composition are needed; another browser-only Planner POST is not that integration. |
| Authenticate protected background authority | Core `auth/workload-authority/objective-workload-*` contains RS256 verification, original/current native observations and durable issuance/JTI/delivery accounting. Meri PR95 has the matching Objective RS256 receiver source. | `apps/api-strategy/src/planner/objective-canonical-authority.ts` still rejects all five methods. The central issuer adapter, raw received HTTP entity-byte capture, accepted-run selection and phase/current-claim binding are unmounted. The existing delegation migration deliberately enforces `enabled=false`; source helpers cannot bypass that constraint. |
| Publish the exact typed Strategy request | `objective-canonical-request.service.ts`, request/ledger modules and regeneration counterparts compile authorized context outside locks, then fence source/basis and publish immutable request/context custody. Initial `candidateVersion` and regeneration `requestVersion` are separate dialects. | Meri `apps/control/objective-generation/core-http.mjs` currently returns `unqualified-response`; a closed decoder/current-read normalizer for the actual backend replies remains missing. Acceptance must not invent an `acceptedAtMs` field. |
| Compile protected Objective execution facts | Meri already has protected-facts readers and strict typed Objective codecs tied to accepted request, immutable issuance, allocation/task, original lineage and fresh Core readback. | `apps/runtime/prepared-run-issuance.mjs` permits only `approvedReads` extensions and omits `objectiveGeneration`/`objectiveStrategy`. The actual producer in `apps/runtime/prepared-run-bindings.mjs` also omits them. Those authenticated producer/compiler seams need composition; posted JSON is not a substitute. |
| Execute through the existing SDK activity | Meri has the existing Claude SDK Objective activity, typed initial/regeneration result validation, fixed output file and native completion custody. Complete request/job/context/owner/selection/expiry hashes are already represented. | `apps/runtime/conversation-runner.mjs` does not pass optional `objectiveGeneration`; native `remote-composition.mjs` does not pass completion's `preparedFacts`. Query selection still needs authentic product-proxy provider/model/upstream/config attestation and private task-read wiring. SHA-bound custody is not a provider signature. Do not implement another worker or Engagement Manager. |
| Return and persist the accepted Strategy result | Backend completion/result owner modules verify retained immutable result/file/checkpoint/request custody and fence the actual Strategy/version/job publication. The HTTP retained-result bridge source exists. | `PlannerModule` constructs `ObjectiveCanonicalResultOwner()` without the HTTP bridge. Named credential/current-authority composition and the reconciled Meri RS256 receiver stack remain required. Existing rejecting defaults must remain until those owners are real. |
| Continue Strategy into Planner after acceptance | `objective-planner-continuation.worker.ts`, runtime, store, native authority, saved-generation owner and application/materialization modules are composed. The worker discovers durable `GENERATION_PRODUCER` rows; application, paired receipts/output and terminal accounting commit together. | The existing legacy UI job does not produce that ledger. Joining its entry to accepted canonical execution is missing; the continuation itself is built. No second Meri Planner orchestrator is needed. |
| Preserve canonical identity and existing edits | Full v2/v3 owner codecs, immutable applied/native lineage, saved schema-2 regeneration basis, retained task identities and final source/version fences exist. Known human edits survive retained reads/recovery. Unknown output identities remain uncertain. | These checks do not claim an arbitrary three-way merge of every manual task, moved membership or human-owned field. Unknown ownership needs an explicit provenance/merge rule, not relaxed absence. |
| Renew an expired consent which never started | This successor proves the required same-ready-source unused-consent path described below, before allowing a fresh explicit Planner retry. Old rows and original execution caps remain unchanged. | Cancelled/control-gap/changed-source bridges and current queued/leased/terminal operations are outside this bounded recovery. A fresh Planner consent cannot revive an expired original Strategy generation/issuance. |
| Distinguish terminal status from new requested work | This successor adds `accounting {outcome,sourceRevision}` only for verified accounted work. A newer requested revision does not relabel an older application. Unknown/unavailable evidence yields null accounting. | Public generation GET still has no authorized canonical job/output discovery. Private operation IDs/receipts are not a browser receiving contract. Current owner/ACL-qualified selectors and authority-redacted history need a separate public contract. |
| Receive and navigate to Strategy/Planner outputs | Existing frontend `ObjectiveGeneratedStrategy.tsx`, `ObjectivePreparedPlan.tsx` and operational association/navigation components verify legacy saved selectors and current output access. Encrypted journals, same-request recovery and cross-tab fencing exist. | No governed consent/status UI is wired. Canonical v3 needs a separate receiving adapter: legacy materialization semantics require created counts to equal all outputs, which is false when v3 retains existing IDs. Do not weaken the legacy decoder or call the private canonical application controller from a browser. |
| Recover after browser closure or source advancement | Backend durable accepted generation/Planner operations survive observation closure. The existing frontend journal can reread saved jobs/materializations and explicitly resume its legacy path. | Closing observation stops an unsent legacy Planner step. Reopening reads rather than automatically submitting it; recovery requires the same current ready Objective version and local journal. Server work discovery and governed current/historical UI receiving remain source work. A real browser-process closure acceptance run is still unqualified. |

The frontend owner confirms that no separately active governed Objective UI
implementer is allocated. That slice should follow pinned Strategy authority,
public discovery and canonical v3 receiving contracts, independently of
Portfolio/Modules and first-chat shipping.

The backend first-chat/funding owner independently confirmed that native Strategy
reconciliation/policy and protected issuer/verifier bindings are not allocated
to that lane. The original delegation reserves central authority files for
coordination; parent/Neo allocation is still needed for those named source gaps.
This successor changes no central authority or module binding.

## Required recovery versus ambiguous history

The ordinary recoverable sequence is:

1. Applied source A has complete immutable paired output/native ancestry.
2. The user advances the Objective to ready source B and explicitly records
   Planner consent C1. No operation starts and no B effect commits.
3. Observation or worker activity is interrupted; C1 expires.
4. A freshly authorized user explicitly retries the same B. Existing command
   semantics allow a new consent for authoritative `not_started` work; they do
   not require editing the Objective merely to renew an unused approval.

PR51 proves step 2 as a read-only status, but deliberately refuses step 4.
That refusal prevented a required recovery. This successor qualifies the
unused path before issuance and also proves the resulting C2 → C1 → A read.
It does not infer permission from expiry alone.

The current consent must be uncancelled, name the exact current ready source,
have no operation/effect, and be expired according to its native row and the
database clock after locks. Each intermediate consent uses its actual immutable
native consent, reciprocal command, original ready intent/revision/hash,
actor/member/Clerk, policy and original times. Renewals have contiguous controls
and predecessor expiry no later than successor confirmation. Traversal is
bounded, unique and ends at the verified applied anchor. A newly admitted
direct renewal also requires the prospective bridge to be contiguous; PR51's
existing direct read remains compatible with its broader historical controls.

Each unused consent's own actor/Clerk-derived exact application/materialization
IDs must be absent. A tenant-wide operation-consent probe ignores kind, owner,
archive and embedded Objective/plan scope. Complete retained ancestry and the
known live/archived output-ID inventory remain mandatory. Unknown identities,
missing evidence, started work, cancellation gaps and malformed history remain
uncertain. A read never becomes a cached write grant.

Consent chains before the first output are already supported by authoritative
no-output accounting. No extra feature was added for that case. The new case
is specifically recovery while older proven output remains. Fresh consent
neither mutates C1 nor extends a generation, issuance, operation or lease.

## Additive authorized read contract

The existing generation GET retains schema version 1 and all previous fields.
It adds:

```ts
requestedSource: {
  revision: { id: string; version: number };
  canonicalBindingVersion: number;
};
accounting: {
  outcome: 'failed' | 'cancelled' | 'applied';
  sourceRevision: { id: string; version: number };
} | null;
```

`objective.revision` identifies the current editable Objective.
`requestedSource.revision` identifies the canonical requested ready revision.
`accounting.sourceRevision` identifies the original consent's accounted work.
These can differ. The browser can use the actual binding version with the
existing Objective/control/target-consent fields when constructing a command;
the server still rechecks every CAS and all current authority/policy.

The projection exposes no private operation/attempt/run identity, original
fingerprint, snapshot hash, actor/member/Clerk or reserved output selector. It
does not assert retry eligibility, dispatch, activation or current editable
output access. The optional command receipt remains a command result, not an
application receipt.

## Integration order and evidence boundary

1. Allocate and review the native Strategy work owner/accounting/policy binding
   and durable chosen-type canonical generation entry.
2. Reconcile and compose the existing central issuer/current-claim/raw-body and
   Meri protected-facts/receiver/SDK/result-return seams. Reuse existing custody
   and typed workers; do not invent background credentials or duplicate Planner
   orchestration.
3. Pin the public authorized discovery and canonical v3 receiving contract.
4. Allocate the frontend consent/reconsent/cancel/status/receiving slice using
   those actual contracts and the read observations above.
5. Qualify the complete accepted execution, server continuation, browser
   closure/reopen, current authorization and truthful partial/source labels at
   an integrated source milestone. Activation remains a separate release action.

PR51's exact parent native result is 20/20 on disposable PostgreSQL 16.15 with
38 hashed focused SQL units; it is not full Core migration replay or a result
for this successor. The successor adds focused source checks and a guarded
native regression using an actual short-lived Planner consent, real DB expiry,
fresh explicit issuance/replay/conflict, retained read and separate runtime
consumption. The exact published successor head, enabled results and independent
review/cleanup receipts are recorded in its PR and task evidence after running.
No earlier result is relabelled as a new run, and no source commit follows the
final successful native qualification.

Real HTTP/JWT/session custody, protected production issuance, SDK/provider
execution, authenticated UI edits, browser-process closure, socket/commit-ack
failure and full migration replay remain distinct qualification boundaries.
Source adapters already listed above must not be described as absent merely
because those runtime checks have not run.
