# Portable Objective -> Strategy -> Planner source handoff

Prepared 2026-10-17 for the separately located Meri implementer, Fable, under
Neo's latest handoff direction. This is a documentation and evidence packet in
`neo-capiro/capiro-backend`, based on the clean reviewed PR51 commit
`81dd0313760c0f18858cb8aa2ad73191da71f138`. It contains no new Meri or Core
implementation, runtime configuration, credentials, database files or deployment
authority. Publication of this packet does not activate any feature.

Read [SOURCE-PINS.json](SOURCE-PINS.json) for checked GitHub heads and named-file
blob identities. Read [EVIDENCE.json](EVIDENCE.json) for every copied evidence
file's task-relative origin, portable archive path, exact bytes, SHA256, source
pin and result classification. All original evidence bytes are preserved; `.log`
files are archived as `.log.txt`, and reviewed PowerShell drivers as `.ps1.txt`.
The archive is deliberately small and requires no prior Windows workspace.
Directory-scoped Git attributes preserve all packet bytes with `* -text` and
disable whitespace diagnostics only for immutable `evidence/**` archives with
`-whitespace`. Archive files remain readable text diffs; the new root documents
retain ordinary strict whitespace checks.

## Ownership and the handoff boundary

Meri implementation is frozen in this lane. No Meri source edits were made by
the Objective continuation lane. The next implementer should recover source
from the immutable Git references below, inspect current repository instructions
and active ownership, and establish a separate integration pin. Do not assume
an open draft or its mergeability means it is integrated or deployed.

The Core coordinator continues an independent source lane from PR51 in
task-owned `objective-flow-integration`. Its reviewed recovery successor is now
[draft PR53](https://github.com/neo-capiro/capiro-backend/pull/53), immutable head
`57f8c8047a73df6d4a73351a98a5239f38240a24`, tree
`cb2ac7d883290741e95d4dffa0f67406ed8e87e4`, parent
`81dd0313760c0f18858cb8aa2ad73191da71f138`. Its owned scope is:

- `apps/api/src/clients/objectives/work/objective-planner-work-owner.ts` and
  `objective-planner-retained-anchor.ts`.
- `objective-planner-current-consent-proof.ts`, the new unused-consent chain
  helper and their focused specifications in that same directory.
- The command-kernel integration, actual Core read projection/specification,
  focused owner tests and native Core retry specification needed by that slice.
- The Core end-to-end source checklist and associated review/qualification.

That slice addresses old applied A -> advanced ready B -> unused C1 -> C1 expiry
-> fresh explicit C2 on B, with complete native consent-chain and absence proof.
PR53 source review is accepted at receipt SHA256
`f98d40ace3c408ab644ceb040b389929e5ef6a7c03a75161c31e161791f0136c`.
Owner/kernel 206/206 and current/unused-consent 157/157 source checks passed and
were independently repeated; actual Core status passed 32/32 and affected/native
strict graphs passed. **Enabled native qualification of PR53 is pending; no
new run had started at this update. This packet's PR51 native result does not
qualify PR53.** The PR53 source/code packet is not copied here: recover it by the
immutable Git reference. These Core paths are not Fable's Meri handoff allocation.
Do not concurrently edit them or replace their authority contract.

Native Strategy reconciliation/policy and the protected Core workload
issuer/verifier are not allocated to the task-3 first-chat/funding owner. Their
implementation needs explicit central allocation by the Core coordinator/Neo.
Do not infer that an unmounted interface is an authorization to modify central
authority files, migration IDs or policy fences.

First-chat shipment, image pins, service bindings, deployment recipes and live
acceptance belong to the shipping owner and are independent of this packet.
Preserve those pins and resources. A previous proposed Fable shipping transfer
was canceled; this source handoff does not transfer shipping ownership or merge
these features into a shipping candidate.

## Immutable source stack

All entries below were checked through supported GitHub reads. They were drafts
at packet assembly. Branch names are navigation aids; use the full commit for
recovery and review.

| Repository / PR | Full head | Full base | Scope |
| --- | --- | --- | --- |
| [Backend PR42](https://github.com/neo-capiro/capiro-backend/pull/42) | `6d24414da975b52ab9802a883b22c868ad14fc92` | `560e3068b67101b68d8675c55835bcc6521110f7` | Objective retained-result, issuance and workload-authority source contracts |
| [Backend PR49](https://github.com/neo-capiro/capiro-backend/pull/49) | `db6ef0a617f4b570cadfa6e05bad7296017d0f70` | `6d24414da975b52ab9802a883b22c868ad14fc92` | Server-owned Planner continuation helpers and government-context policy |
| [Backend PR50](https://github.com/neo-capiro/capiro-backend/pull/50) | `5591eac08428635bf911a0aa32acea859e2a5d95` | `db6ef0a617f4b570cadfa6e05bad7296017d0f70` | Runtime composition, full applied ancestry and advanced-source Plan consent; exact-head bounded native 20/20 |
| [Backend PR51](https://github.com/neo-capiro/capiro-backend/pull/51) | `81dd0313760c0f18858cb8aa2ad73191da71f138` | `5591eac08428635bf911a0aa32acea859e2a5d95` | Retained older-head status for immediate current consent with no current operation; exact-head bounded native 20/20 |
| [Backend PR53](https://github.com/neo-capiro/capiro-backend/pull/53) | `57f8c8047a73df6d4a73351a98a5239f38240a24` | `81dd0313760c0f18858cb8aa2ad73191da71f138` | Reviewed unused-consent recovery and generation read projection; source checks accepted, enabled native qualification pending |
| [Meri PR95](https://github.com/neo-capiro/meri-greenfield/pull/95) | `5781c1150fbb3954c25ba245b26d325e06b4d82d` | `d27c807bb5694cf84c73db5d647e2e8d13ba39f1` | Unmounted RS256 retained-result receiver contract |
| [Meri PR109](https://github.com/neo-capiro/meri-greenfield/pull/109) | `b4daa4adf6e8269e7c341751db9a02bf6d4f062b` | `526b6be7c906c15298f13430fe5dd5a9db458e03` | Later ordinary/read stack inspected for Objective composition; funding bridge remains a separate concern |
| [Meri PR110](https://github.com/neo-capiro/meri-greenfield/pull/110) | `f7f4ed5b397fcd44576251739ed361aee6941d7a` | `b4daa4adf6e8269e7c341751db9a02bf6d4f062b` | Latest checked ordinary/read successor; ten named Objective composition files match PR109 exactly |
| [Frontend PR58](https://github.com/neo-capiro/capiro-frontend/pull/58) | `4e1421054df0d32c564f7c9bc75cbd5e5366b428` | `0b6c7ecf2c3f0f66dee5a0e88cb67528a6cc5fc2` | Existing Planner drafts and Objective receiving implementation |
| [Frontend PR62](https://github.com/neo-capiro/capiro-frontend/pull/62) | `9e6d80843b0a46a862f7613b4ab9b08d925d7b17` | `aae57e924e5812f331c76557f2b7ccaddd4ba0f9` | Personal Meri preferences; inspected current source context inheriting Objective receiving, not an Objective qualification PR |

The frontend Objective-flow audit also identifies the earlier feature change
`ee5f04469c1fbf0e14842785e345ab5964770086`. The full PR58/62 pins above are the
portable checked recovery references; no short or machine-local pin is required.
Seven named Objective frontend blobs were independently fetched at both PR58 and
PR62 and are identical, as recorded in SOURCE-PINS.json. This establishes those
file bytes, not governed-flow completion or whole-frontend equivalence.

## What is already built

Core owns native Objective revisions, canonical associations, human consent,
current membership/client/wall checks, immutable command receipts and approval
and idempotency rules. Its typed generation admission captures the original
tenant, native user/membership, Clerk, source revision/version/snapshot and
canonical plan/epoch/Strategy/project binding. The compiled generation context
includes the Objective, client/government and relationship sources, coverage
and evidence references; the saved Strategy/version is the owner of subsequent
Planner materialization. Do not create a parallel Engagement Manager or move
these responsibilities into the browser/model.

PR50/51 compose the actual dedicated Planner worker, operation store, local
native authority and atomic materialization/accounting path. The worker
discovers durable accepted generation producer rows. It does not need the
originating browser request to stay open. Original operation/attempt/run,
fingerprint, actor/Clerk/membership, consent, lease and deadline stay fixed.
Complete v2/v3 application/materialization ancestry and native consent lineage
are reconstructed before historical applied accounting or regeneration. A
new human consent does not renew old generation authority or an old receipt.
PR53 adds reviewed source for expired unused-consent recovery and an authorized
generation GET projection: `requestedSource {revision, canonicalBindingVersion}`
and verified `accounting {outcome, sourceRevision}|null`. These support future
governed frontend commands without guessing a binding or confusing older applied
accounting with newly requested work. Private owner/output IDs and execution
authority are not exposed. Public output discovery, canonical-v3 receiving and
governed frontend wiring remain separate missing integrations.

Meri already has the following cohesive source modules at PR109, unchanged in
the ten explicitly compared Objective files at PR110:

- `packages/runtime/objective-generation-custody.mjs` and
  `objective-strategy-protocol.mjs`: original issued selection, full accepted
  request and binding, deterministic completion identity, initial/regeneration
  protocol selection, execution witness and immutable typed-result custody.
- `apps/worker/conversation/objective-generation/runtime.mjs`,
  `typed-result.mjs` and `fixed-file.mjs`: one existing SDK query's protected
  selection, typed output format, candidate validation and fixed result file.
  The existing Claude Agent SDK remains the model loop; no second loop is needed.
- `apps/worker/conversation/activity.mjs`: optional `objectiveGeneration`
  preparation/capture hooks around the existing query and completion path.
- `apps/runtime/native-authority/completion-capture.mjs`: typed selection and
  completion journaling, immutable checkpoint/object readback and replay.
- `apps/runtime/objective-generation/prepared-facts-reader.mjs`: reads an
  already-issued entry after current run, issuance, admitted allocation, task
  and authenticated current Core readback checks; it issues nothing on read.
- `apps/runtime/objective-generation/query-selection-reader.mjs`: compares
  actual model issuance/material and a separate proxy owner's current
  provider/model/upstream/config attestation with the protected selection.
- `apps/runtime/objective-generation/retained-result.mjs` and
  `core-result-owner.mjs`: fresh current identity/context and retained published
  completion/result custody, independent of expired task/model leases.
- `apps/control/objective-generation/core-http.mjs`: fixed bounded Core
  admission/publication/acceptance transport with credential rechecks.
- `apps/control/objective-planner/continuation/{contract,core-http,core-client,core-producer}.mjs`:
  deterministic canonical application identities, actual immutable Core ACK
  validation and producer readback. These are existing external adapters.

The private candidate request/result validators exist in
`packages/contracts/strategy-operations-candidate` and
`packages/contracts/objective-regeneration-private`. Their validation and hash
checks are consistency rules, not issuers or grants.

## Concrete missing source integration

The gaps below are established from actual source, not inferred from the use of
synthetic native qualification. Existing adapters should be composed or extended
after owner allocation rather than duplicated.

| Boundary | Actual missing integration / decision |
| --- | --- |
| Strategy human consent | `ObjectiveWorkModule` binds `ObjectivePlannerWorkOwner`; its reconciliation returns unavailable for `objective.strategy.draft`, and its mount spec asserts refusal. Ordinary Strategy/pair consent cannot succeed through this owner. Core needs a separately allocated native Strategy reconciliation/accounting and policy binding. |
| Core protected HTTP authority | `apps/api-strategy/src/planner/objective-canonical-authority.ts` methods at lines 55-84 reject. `planner.module.ts` mounts that default. Real generation admission/request/acceptance/completion/application HTTP bindings are still required. |
| Core durable workload issuer | RS256 issuer/verifier, proof validation and durable decision/JTI/delivery accounting are implemented. `objective-workload-issuance.ts` and its Prisma port support admission only; later-phase production native owner/SQL binding is absent. No new credential may be fabricated from echoed hashes or model/browser data. |
| Core delegation fence | Migration `20281016010000_client_objective_workload_delegations/migration.sql` intentionally enforces `CHECK(enabled=false)`. Changing this is a central migration/authority decision with qualification, not an environment toggle. No migration is changed by this packet. |
| Core result owner | `planner.module.ts` constructs `ObjectiveCanonicalResultOwner()` without the existing retained HTTP bridge. Bind a named credential owner, fixed Meri origin and genuine current retained-result owner after allocation. |
| Core HTTP byte capture | `apps/api-strategy/src/main.ts` installs ordinary JSON parsing, without the actual entity-byte capture needed by the protected JWT body hash. Request-object hashes cannot replace verification of the bytes received at ingress. |
| Meri closed Core reply decoder | `apps/control/objective-generation/core-http.mjs` currently returns `kind:'unqualified-response'` (line 90). Build a closed phase-specific decoder and fresh `coreCurrent.readCurrent` normalizer against the now-existing Core contracts below. Returned JSON or matching timestamps alone are not authority. |
| Meri protected fact production | **Exact path:** `apps/runtime/prepared-run-bindings.mjs`, `facts.compile` at lines 62-71. It issues the model grant and returns ordinary runtime/plan/allocation facts, but never `objectiveGeneration` or `objectiveStrategy`. Extend the trusted producer using genuine authenticated Core source/accepted-run observations. |
| Meri immutable fact compiler | `apps/runtime/prepared-run-issuance.mjs:40-53` closes the allowed input keys with only optional `approvedReads`, and omits both Objective fields from the immutable facts hash. Compose their validation and persistence with the same canonical issuer; do not add a second journal/issuer. |
| Meri SDK mount | `assembleConversationRunner` in `apps/runtime/conversation-runner.mjs` never accepts/passes the existing optional `objectiveGeneration` owner to `createConversationActivity`. `apps/runtime/native-authority/remote-composition.mjs:47` calls completion capture without `preparedFacts`. Both are real source composition gaps. |
| Meri actual query selection | The query-selection reader has no supplied production proxy-attestation port. It needs authenticated current ACTIVE model/task/provider/model/upstream/config facts and a private task read operation tied to the existing capability. Existing generic proxy owner/delivery source is partial input, not proof that this Objective port is mounted. |
| Meri retained ingress | Compose a fixed accepted-run/source/result-owner selection, actual current authority, fixed public keys and durable atomic same-JTI operation replay around the PR95 receiver. No ingress route, issuer/key or replay store is mounted by the receiver module. |
| Frontend governed Objective flow | Existing receiving/draft UI and recovery remain. The audited PR58/62 source uses legacy generation/receiving, with no governed work-command/pair-confirmation/status calls. A frontend owner must be allocated once the native Strategy owner and public contracts are ready. No Objective UI implementer is allocated by this packet. |

A minimal independently reviewable Meri source slice is the closed Core reply
decoder/current readback normalizer. It can be implemented without changing the
model loop or enabling source connectivity. Fact compilation, SDK mount and
receiver composition should follow only with the required genuine protected
owner inputs and a coherent reviewed integration pin. Core authority and
migration work remain centrally owned dependencies.

## Receiver divergence and signed execution custody

Meri PR95 is not an ancestor of the later ordinary/read stack. The checked
PR95-to-PR109 comparison diverges at
`d27c807bb5694cf84c73db5d647e2e8d13ba39f1`, with PR109 29 commits ahead and one
behind. PR110 descends from PR109; its named Objective files are unchanged.
The current later-stack `apps/control/objective-generation/workload-reader-gate.mjs`
therefore still has the old EdDSA/nested layout (blob
`9ff7c49acc104c194d4284b92d00652ad00f65fa`). The PR95 RS256 receiver blob is
`23543d8d8a6f7fca57ff6e7e4e8d8e3544f56848`.

Reconcile the existing PR95 receiver at a new reviewed Meri integration pin.
Do not design a third token dialect or assume PR95 is already included. Its PR
body's historical statement that Core emitted only 20 claims predates the
current Core implementation. Core81dd contains the 21-field RS256 retained-read
issuer/verifier and public-only signed fixture source; that old body is not
evidence that a new protocol design is missing. Signed fixture compatibility
is offline evidence, not an installed signer or live ingress qualification.

The fixed retained read is `POST
/v1/internal/objective-generation/retained-result/read`, with empty query,
operation `objective.retained-result.read`, phase `retained-result-read`, subject
`capiro-objective-core-result-reader:v1`, audience
`capiro:objective-meri-retained-result:v1`, and token type
`capiro-objective-workload+jwt`. The full flat claims include issuer, subject,
audience, issue/not-before/expiry/JTI, method/path/query, exact raw-body SHA256,
operation/phase, tenant/job/delegation/consent/attempt/run, accepted binding hash
and source hash. PR95 requires fixed RSA public keys of at least 3072 bits,
canonical wire form, fresh current accepted-run/source/custody checks and
durable same-JTI replay/conflict/UNKNOWN handling. No worker-selected source or
generic result owner may bypass those checks.

The complete accepted `RunBinding` is exactly tenantId, actorId, conversationId,
runId, attemptId, workerId and writerFence. Original Clerk actor is opaque and
must not be replaced by a current reader or guessed native UUID. Typed custody
also binds the accepted request, Core admission/request hashes, Objective
source revision/version/snapshot, context/coverage/evidence/owner references,
actual provider/model selection, native session/completion and immutable result
file/object/checkpoint hashes. `execution.receiptSha256` is a SHA-bound custody
witness; it is **not a provider signature**. The independent RS256 workload
authentication and real issuer/proxy/native custody checks are still required.

No fresh read, new consent, recheck, task restart or replay extends the original
saved-generation effect expiry, issued fact expiry or operation deadline.
Historical and current authority are distinct: retained consistency can survive
old consent expiry, while the current human/request/result reader must still
pass its own current authority gate.

## Exact Core replies for the Meri decoder

At backend81dd the initial private routes use body exactly
`{schemaVersion:1,generationJobId}`. The transport's request identity digest and
the signed raw HTTP entity-byte digest are different domains. GET has no entity
body even when a service identity digest describes the job. Preserve both.

| Phase | Closed reply |
| --- | --- |
| POST `/strategy-api/internal/objective-canonical/generation-admissions` | `{schemaVersion:1,sourceAdmission,sourceAdmissionSha256}`; producer service line 98 |
| GET admission `/<generationJobId>` | Same admission plus `acceptance:{availability:'available',value:acceptance}` or `{availability:'unavailable',value:null}`; producer service lines 177-179 |
| POST/GET `/strategy-api/internal/objective-canonical/generation-requests` | Bare publication `{schemaVersion:1,sourceAdmissionSha256,request,requestSha256,executionContext:{schemaVersion:1,prompt,promptSha256,ownerRefs:[{ownerRef,clerkUserId}],contextPacketId}}`; `objective-canonical-request.ts:60-63` and service lines 158/175 |
| POST `/strategy-api/internal/objective-canonical/generation-acceptances` | `{schemaVersion:1,sourceAdmissionSha256,sourceBinding,sourceRequestSha256,issuance}`; producer service lines 152-154. There is **no `acceptedAtMs`** in this reply. |
| Completion POST/GET | `{schemaVersion:1,generationJobId,sourceAdmissionSha256,sourceBinding,sourceRequestSha256,completion,objectiveReceipt,objectiveReceiptSha256,snapshotDigest}`; `objective-canonical-saved-generation.ts:56-61` |

`sourceAdmission` is closed schema 1 with namespace
`capiro.objective-strategy.admission:v1`, canonical, actorUserId, clerkUserId,
consentId, controlVersion, generationJobId, generationRequestId, admittedAtMs,
effectExpiresAtMs and expectedStrategyVersionId. The issuer receipt is exactly
issuanceKey, binding, requestSha256, expiresAtMs, grantId, capabilitySha256 and
factsSha256. An accepted reply must be compared with the genuine original Meri
issuance and protected facts, not invented from the HTTP request or a matching
hash alone.

Initial request uses `candidateVersion:'strategy-candidate/20261015.2'` and
`basis:null`. Regeneration uses
`requestVersion:'capiro.objective-strategy.regeneration-request/20261016.1'`, a
non-null complete basis, basisSha256 and applicationTarget. Keep these as
separate closed dialects; do not normalize one into the other or weaken their
candidate validation.

## Planner delegation and the return path

The required ordinary route is native human consent -> Core source admission
and immutable typed publication -> genuine Meri accepted issued facts -> actual
SDK query/native completion and retained result -> authenticated Core retained
read/acceptance/completion -> saved Strategy/version and durable generation
producer -> **Core's existing Planner worker** -> atomic canonical Planner
application/materialization/accounting -> current frontend receiving/projection.

Meri's existing continuation HTTP clients target
`/strategy-api/internal/objective-canonical/generation-producer/admit` and
`/strategy-api/internal/objective-canonical/planner-applications`. Their work
contains canonical, original native actor, consent/control, generation IDs,
Strategy/version, Objective receipt SHA, snapshot digest and deterministic
application request ID. Their credential owner must independently attest the
exact operation/phase/route/body/source and current original authority.
Application creation ACK and current projection are separate observations.

These clients do not establish a missing Meri orchestration requirement.
Completion already records the generation producer atomically; the mounted Core
worker discovers it and continues without a browser callback. Do not add a new
Temporal/Engagement Manager Planner loop to duplicate that owner. Keep ordinary
authenticated chat independent of Objective-specific ingress/issuer mounts.

Runtime activation remains held by process
`OBJECTIVE_PLANNER_CONTINUATION_ENABLED=true`, Core consent duration
`OBJECTIVE_PLANNER_CONSENT_DURATION_MS` in 1..1800000, tenant
`objectivePlannerContinuation.enabled=true` and existing tenant
`clioFeatureFlags['strategyPlanner.enabled']=true`, plus genuine current native
membership/client/wall/source/consent. These are descriptions of existing gates,
not configuration changes or permission to set them. They cannot bypass the
disabled delegation migration or the rejecting protected HTTP authority.

## Portable evidence and what each run establishes

All five folders under the original `objective-planner-native-evidence` and the
final PR51 folder are copied in full. No outcome artifact means **not qualified**;
a passing default-off check or partial runtime suite does not qualify a run.

| Run | Exact source | Recorded result |
| --- | --- | --- |
| `1e1fb8dca05e4a5aa6989fba71ba6982` | `b8b7262aa0ae8b4d9ef30e75df41b147b2d6e3cf` | Partial startup/connection-refused path; no `outcome.json`; not qualified |
| `90ac1a229e664ccab6c2ad82be69813e` | `b8b7262aa0ae8b4d9ef30e75df41b147b2d6e3cf` | 13 passed: 12 native plus default-off; historical b8 only, not later source |
| `06b740e91e434629ba943bb6cf977ded` | `3ebecd93f3d5a99e1d9346b2710a3605591ed9d3` | 18 failed native catalog-guard cases, one default-off passed; no outcome; not qualified |
| `0f0d742263cd40689cf6b0bcff4e2c53` | `a82e49b1d6c0949b898b914840ece813008fe2e7` | 16 passed/3 failed in native Core proof path; no outcome; not qualified |
| `27e98d3a48a44c5081d7ca465f045ce9` | `5591eac08428635bf911a0aa32acea859e2a5d95` | Final PR50: 20/20, comprising 19 native plus default-off; exact source/tree and cleanup independently reviewed |
| `14317236bdb14f3b8c39a39217f6a9c3` | `81dd0313760c0f18858cb8aa2ad73191da71f138` | Final PR51: 20/20, comprising 19 native plus default-off; exact source/tree, seven evidence files and cleanup independently reviewed |

The final two runs used disposable PostgreSQL 16.15 at task-owned loopback
127.0.0.1:56455/planner_qa, restricted non-owner/non-superuser/non-BYPASSRLS
`capiro_app`, a separate non-login DDL owner and 38 hashed SQL source units:
four focused Core selections, 28 Strategy migrations and six Objective
migrations. `uuid-ossp`, `citext` and `pg_trgm` were installed; unavailable
`vector` was explicitly omitted. This is **not full Core migration replay**.
Each final run records 13 preflight cases passed, 19 enabled cases skipped in
preflight, 20 enabled cases passed and all 52 child exits zero.

The final outcome files retain `cleanupPending:true` because they were written
before `finally`. Their completed cleanup files, final checkpoint and
independent evidence review resolve this marker. PR50's recorded process 15016
and PR51's 26664 were gone, their owned clusters/private listeners were removed
and disposable credentials retired; existing host 5432/PID4936 was preserved.
These are historical source-machine observations, not claims about Fable's
machine or authority to start a database there.

The packet preserves all nine outside-repository source/native review receipts,
including the expressly **SUPERSEDED/WITHDRAWN** historical review for tree
4883e34. Its publication hold is not acceptance; the subsequent final chronology
receipt supersedes it. Final source checkpoints preserve the limits that were
true at their own pins. PR50's immediate older-head status limitation is addressed
by PR51's narrower read proof; neither supplies enabled native qualification for
PR53's reviewed unused-consent renewal source.

The two reviewed final drivers are archived text references with SHA256:

- PR50 `run-isolated-sourceplan.ps1.txt`:
  `717bade635a69fd71a425eff35ffd821da569277d3f2de520005b49bec6af5c5`.
- PR51 `run-isolated-retained-head.ps1.txt`:
  `76c30a3fa8a3cf8b4f2ebfb41212db337a0004c58ab6d37de5759a417795b945`.

They contain historical Windows paths and strict owned-target checks. They are
not executable handoff scripts, machine configuration or an approval to create
credentials/schema. Any future native procedure needs a separately reviewed,
allocated target and exact final source pin; do not edit paths and assume the
old result transfers.

The native suites use synthetic current request-proof transport, Strategy
generation consent and Meri/provider custody observations. They do not establish
real HTTP/JWT/session/protected issuer, real SDK/provider dispatch, authenticated
browser interaction, browser-process closure, deployed recovery, full migration
replay or real socket/COMMIT-ACK failure injection. Current queued/leased/failed/
cancelled work beside an older head, intervening unused consents and unknown
added output identities require the separate stated contracts; do not treat
uncertainty as absence or fabricate a no-op operation.

## Packet verification and recovery on another machine

Recover each repository in a separate task-owned checkout at its full immutable
head. Read Meri `AGENTS.md`, `docs/IMPLEMENTATION-STANDARDS.md` and the current
continuation guide at the selected integration pin; Neo's latest explicit
handoff direction governs project assignment. Do not reset an existing checkout,
reuse another owner's candidate or infer credentials from the archived paths.
No `.git`, dependency tree, raw archive, credential or live configuration file
is included here. No dependency installation is needed to inspect this packet.

From this packet directory, standard Node can verify all archived source bytes:

```sh
node -e "const f=require('node:fs'),p=require('node:path'),c=require('node:crypto'),m=JSON.parse(f.readFileSync('EVIDENCE.json','utf8')); for(const e of m.entries){const b=f.readFileSync(p.resolve(e.archivePath)); if(b.length!==e.bytes||c.createHash('sha256').update(b).digest('hex')!==e.sha256)throw Error('Evidence mismatch: '+e.archivePath);} console.log(m.entries.length+' archived files verified');"
```

The bounded credential scan ran before any evidence copy: UTF-8 validation,
disallowed-control detection and six credential pattern families. Two reviewed
matches are only variable-based URL construction in archived driver source;
their locations/dispositions are retained in EVIDENCE.json. No actual password,
private key, compact bearer/JWT, AWS access key or generated 96-hex disposable
secret was detected. UUID ownership tokens are public cluster ownership
metadata. Pattern scanning is bounded evidence, not exhaustive secret detection.

The coordinator publishes this docs-only packet after independent review and
delivers its immutable Git reference through the primary task. PR53's immutable
Core source reference is separate from this packet's archived native evidence;
its enabled native result will require its own exact-pin delivery. Source
review, native qualification, runtime activation and shipping acceptance remain
separate decisions; this packet supplies the source context and preserved
evidence required to make the next implementation concrete.
