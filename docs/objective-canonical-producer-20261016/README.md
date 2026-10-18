# Canonical Objective producer and plan reconciliation

Authored source only. This successor preserves prior sealed checkpoints and
their actual failed/unrun evidence. It does not enable a workload verifier,
apply SQL, establish runtime custody or qualify automatic completion.

## Concrete initial writer and producer

`MeriService.applyCanonicalDraft` accepts a backend-normalized typed draft and
its retained admission, then reuses the existing Strategy/nodes/exact-version
transaction. It persists the actual reserved canonical Strategy ID and stable
server-normalized node IDs. It invokes no model. The Objective completion hooks
fence the exact claim/attempt/current source and publish the real job/result
receipt plus generation producer evidence in that same transaction.

The writer derives the complete DTO from the actual owner-read job; its caller
cannot supply a replacement DTO. It compares the immutable input again after
the existing completion hook locks the job and sources. A fourth private
generation ledger kind retains rationale/coverage, normalization hashes and
ordered source-key/node-ID mappings after the exact version is cut, before job
completion. It is excluded from public resource access and has no share token.
This is application-level insert-only behavior in the existing table, not a
new DB immutability guarantee or proof of SDK result selection.

`objective-canonical-draft.ts` rejects malformed/oversized source rather than
slicing or repairing it, maps source-key dependencies once, and retains explicit
normalization/coverage hashes. Its reviewed external candidate is
`meri-greenfield@4d8bd8ee3d3c6f0c5e1c91edbfebe44598dcf7af`. That draft still has
`basis:null`. The actual writer refuses a nonnull expected existing Strategy
version; downstream Planner reconciliation does not enable upstream Strategy
regeneration. Owner references require a real currently authorized server map;
the normalizer cannot invent an owner or prove result custody.

The registered producer controller uses fixed paths beneath
`/strategy-api/internal/objective-canonical`:

| Method / suffix | Success | Source behavior |
| --- | --- | --- |
| POST `generation-admissions` | 201 | Captures one real queued, unclaimed Objective job and its original canonical/source/consent/expiry. |
| GET `generation-admissions/:generationJobId` | 200 | Rebuilds retained admission and optional acceptance with current read authority. |
| POST `generation-acceptances` | 201 | Requires verifier-owned original Meri request/run/issuance readback and claims that exact job. |
| POST `generation-producer/admit` | 200 | Checks completed generation evidence and the exact `start`/`prepare`/`read`/`stop` work envelope. It neither applies Planner outputs nor remotely cancels a worker. |

The first and third POST bodies contain only schemaVersion and generationJobId;
the caller cannot supply an actor, canonical target, consent or run binding.
Producer admission reports actual generation evidence, not Planner success. The
original generation consent and subsequent Planner consent are separate action
grants. All concrete workload/current-claim/acceptance verifier methods still
fail with `AUTHORITY_UNAVAILABLE`.

## Two-action confirmation

The Core `POST /clients/:clientId/objectives/:objectiveId/generation/confirm-pair`
route returns 200 with two existing action receipts. Its closed body carries
schemaVersion, expectedObjectiveVersion, expectedCanonicalBindingVersion, and
strategy/planner objects containing requestId, expectedControlVersion and
targetAuthorizationRequestId. The fixed actions are `objective.strategy.draft`
and `objective.plan.prepare`; caller-selected action names are not accepted.

Both owner/policy preflights precede consent writes in one transaction, with
separate original consent IDs, existing 30-minute policy and final expiry gates.
A missing half of a historical pair refuses. Two existing exact receipts are
historical action receipts, not proof of a new durable pair record. The actual
Core owner/settings adapter remains unconnected, so this route currently fails
closed rather than issuing usable workload authority.

## Actual deterministic Planner v3 writer

The existing private Planner application POST/GET remain beneath
`/strategy-api/internal/objective-canonical/planner-applications`, with POST 201
and GET 200. The nine-field request, immutable ACK schemaVersion 1 and legacy
public/manual input/groups/issue decoder are unchanged. The passed-transaction
owner accepts a checked paired predecessor from the real application head.

Initial owner receipt v2 remains readable unchanged. Owner receipt v3 reconciles
an advancing Objective revision/binding into the same canonical project. It
reuses cumulative source-node/task IDs, adds only genuinely new rows, retains
removed tasks/history, and preserves human execution state, memberships,
multihoming and manual fields. Source-owned name/description, date/subtype and
whole dependency fields use last-machine-baseline three-way comparison. A human
value wins without resetting that machine baseline.

Project/mapped-task rows are locked and current editor/client/archived state is
checked. All patches and the complete merged human/task dependency graph are
validated before writes. Missing/cyclic references, or a proposed task edge
left unapplied by human preservation, cause 422 and zero writes. There is no
silent edge drop, archive/delete/restore, public saveTask invocation, recurring
successor, rules, outreach, external activation or second model run.

V3 counts `createdProjects:0` and only genuinely new `createdTasks`; this is
retained application accounting, not task-output length or current readable
totals. `createdVersion` retains original row creation version 1. Private
before/applied row versions witness this application; current observations may
later advance. The canonical-only safe issues are:

- `HUMAN_EDITS_PRESERVED`: `Existing human edits were preserved during plan reconciliation.`
- `PRIOR_WORK_RETAINED`: `Work from a prior saved version was retained.`

No new fields enter the ACK. It hashes the complete validated v2/v3 owner
receipt. The output rows, owner receipt, immutable application ACK and applied
head commit in the same transaction with final fresh claim/source/consent/DB
clock fences. Current permission-filtered observation stays separate; any
withheld output ID withholds the whole immutable ACK and SHA. Missing or
malformed original paired evidence remains uncertainty, never permission to
mint another effect.

The v3 checker reconstructs identities, baselines, versions, groups, edges,
counts and issues against its checked predecessor. Raw observed human values,
memberships and the whole tenant graph are not duplicated in the receipt;
their hashes are transaction witnesses from actual locked reads/merge checks,
not independently recoverable proof. See [reconciliation details](CANONICAL-REGENERATION.md)
and [the private application schema](../objective-background-evidence-20261016/CANONICAL-APPLICATION.schema.json).

## Genuine remaining gates

- Bind the real named workload issuer/audience/delegation and transaction-local
  current claim witness, plus genuine accepted request/run/issuance readback.
  Generic secrets, Clerk-context hashes and model/budget tokens are insufficient.
- Bind actual immutable typed-result/request/execution custody to normalization
  and the initial writer, including current owner-map and evidence-review
  authority. Authored admission fields and hashes alone cannot prove that chain.
- Allocate the reviewed typed regeneration basis, cumulative stable source-key
  association and existing-Strategy version writer. Same-revision deliberate
  regeneration also needs its separate request/head policy; neither is enabled.
- Connect real owner reconciliation/settings for explicit retry; UNKNOWN never
  authorizes a fresh identity. Consent rows do not mint workload credentials.
- Qualify the exact integrated source with semantic typing, real owner/HTTP
  regressions and native PostgreSQL grants/RLS/concurrency/rollback. This docs
  update runs no tests and makes no new acceptance claim; old counts retain
  their original source scope. Runtime/provider/Temporal/browser completion is
  not established by source fixtures or by this document.
