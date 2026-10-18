# Core Strategy intake: held interface and existing owners

Baseline: backend PR56, commit `bdcb546804f35d0973603fca5e99dbd4d640953f`.
This document records source boundaries and future interface requirements.
The accompanying source adds an unmounted admission-only ingress factory and
native routing resolver, and removes locking SELECTs from three immutable
issuer ledgers. It does not mount a route or allocate a new schema, Strategy
work owner or dispatch permission. Offline checks do not qualify native
privileges, transport or deployment.

## Existing source and actual holds

| Owner | Built source | Remaining binding |
| --- | --- | --- |
| Human work consent | `apps/api/src/clients/objectives/work/objective-work.service.ts`, `objective-work-command.ts` | Native request proof, current tenant/member/Clerk/client wall, ready source, CAS, immutable consent/command and release checks exist. The mounted owner is Planner-only; Strategy reconciliation and policy remain unavailable. |
| New-consent duration | `apps/api/src/auth/workload-authority/objective-consent-policy.ts` | Existing revision caps a new explicit consent at 30 minutes and clips genuine tighter request/action/tenant/delegation limits. This policy does not issue a credential or establish an old operation's outcome. |
| First issuer phase | `objective-workload-issuance.ts`, `objective-workload-issuance-prisma.ts`, `objective-workload-current.ts` in the same directory | Durable admission-only decisions, proof-use receipts, claim-before-sign delivery and exact current native source are implemented. New `objective-workload-admission-ingress.ts` composes the real caller verifier and durable issuer; `objective-workload-admission-source.ts` resolves native scope and fixed target bytes. Both default disabled and are unmounted; signer/trust configuration and genuine source remain required. |
| Issuer schema | `apps/api/prisma/migrations/20281016010000_client_objective_workload_delegations/migration.sql` | Delegations have `CHECK(enabled=false)`. No production delegation-creation writer is present in the baseline. Configuration cannot remove this database fence. No migration change is proposed here. |
| Actual Strategy admission | `apps/api-strategy/src/meri/objective-canonical-generation-fence.ts`, `objective-canonical-producer.service.ts` | These derive admission from the real never-claimed job and exact current Strategy consent/source. Their named workload authority is default-closed. |
| Typed publication and context | `objective-canonical-request.service.ts`, `objective-canonical-job-input.ts` in the same Strategy directory; Core `context/objective-generation-context.service.ts` and `strategy-context-plane.service.ts` | Reuse original job type/request and the existing full client/government relationship context. Incomplete required context refuses generation. Do not rebuild an Engagement Manager or store a duplicate context corpus. |
| Saved completion | Strategy `objective-canonical-saved-generation.ts`, `objective-generation-completion.ts` | Full original admission/acceptance/publication/completion/normalization/producer/saved-version reconstruction exists. It is consistency evidence, not new-effect authority or absence proof. |
| Later authority and custody | Core `objective-workload-later-current.ts`; Strategy `planner/objective-canonical-authority.ts`, `meri/objective-canonical-result-owner.ts` | Later native readers, authenticated original accepted-run observation, separate accounting observation and retained-result transport need real composition. A coherent stored acceptance is not independent Meri custody. |

The baseline `ObjectiveCanonicalWorkloadAuthority` rejects all its methods.
The baseline result owner is mounted without a bridge. The new admission
factory does not change those bindings, create a delegation, lift the
database fence or enable a receiver. Its exact wire contract and focused
source checks are recorded separately in `CORE-ADMISSION-QUALIFICATION.md`.

## Immutable selection required before native dispatch

The current Work command and pair confirmation identify an action, exact
Objective/canonical versions and consent CAS, but do not select a Strategy
type. Actual `ObjectiveDraftRequest.type` is one of `appropriations`,
`authorization`, `regulatory`, `coalition`, `procurement`, `earmark` or
`amendment`. It is independently checked against the actual stored job before
publication. An Objective's `askType`, a Planner choice, an old Strategy or a
reserved output ID cannot supply this missing selection.

A future versioned intake must bind these facts immutably:

- The human command/request identity, selected type and exact source revision,
  Objective version, canonical plan/epoch/binding and root intent.
- The actual consenting native actor and membership plus original Clerk
  mapping, consent/control identity and issuance control version.
- The original typed generation request ID, exact parsed request fingerprint
  and actual `objective-v1:` job request key.
- The actual durable job and original operation association, with original
  deadlines and the real canonical target derived by the existing owners.

The storage owner and versioned request shape still require allocation. A
subsequent request must not silently fill in or change a type after approval.
Exact request replay returns the existing original identity; changed selection
under that identity conflicts. No attempt/run/claim or Meri issuance identity
exists before genuine acceptance and none may be fabricated to satisfy a DTO.

## Atomic intake and reconciliation gate

`DraftJobService.submitObjective()` currently commits an unmarked queued job.
The legacy worker can claim queued jobs without `canonicalGeneration` before
a later `ObjectiveCanonicalProducerService.capture()` transaction starts.
Composing these two public/service calls does not provide atomic native intake.

The allocated native intake must create or recover the actual job, capture its
canonical admission, store the private canonical marker and bind the original
operation/consent/request in one transaction before the queued job becomes
visible to a worker. The existing remote issuer needs committed job visibility;
achieving atomic intake therefore requires an explicitly reviewed internal
transaction authority or a genuine reservation protocol. Chained HTTP calls,
fabricated requests or prewritten admission records cannot establish that
invariant. Retain the existing canonical Strategy producer and completion
writers. No second Strategy model loop is proposed.

Lock design must be agreed with every actual writer. Core's current source
reader uses job -> native scope -> canonical -> control -> delegation;
the issuer takes its operation advisory gate after the first source read and
rechecks current facts after the wait. The Strategy admission path also locks
the Strategy head before its current-source/control checks. Preserve those
owners' established ordering when defining the intake transaction. Core's
`lockOwner()` precedes its native scope locks, so a new gate there must not
invert the actual producer's locks. A private gate used only by a reader does
not establish owner exclusion.

Under the agreed shared writer gate, reconciliation must enumerate the exact
original operations, actual jobs, admissions, acceptances, publications,
terminals, saved producers and output/version owners with a bounded complete
inventory. Exact deterministic identities need tenant-wide probes independent
of kind, archive, embedded scope or alleged owner. Unknown, malformed, foreign,
orphaned, overflowing or in-flight evidence remains `outcome_unconfirmed`.
Missing job/head/producer, timeout, closed browser or failed HTTP response is
not `not_started`. Positive absence requires the same atomic owner invariant
as all effects and their operation records; unknown outcomes never allocate
a fresh operation.

The current kernel's applied-to-new-source retry exception is Planner-specific.
A Strategy regeneration exception would need its own verified current-source
and historical-accounting contract and explicit kernel allocation. Old applied
evidence must stay applied. Raw failed job state or expiry is not a terminal
receipt: current terminal services accept genuine initial-generation
`needs-information`/`refused`, while regeneration and physical failed/cancelled
accounting remain held without their actual proof owner.

## Issuer and receiver requirements

Use the dedicated named workload proof and issuer contract, with fixed phase,
service subject, audience, actual route and transmitted entity bytes. An
issuer ingress must capture bytes before parsing; JSON reserialization is not
the request. Its trusted resolver derives tenant, consent, delegation and job
from native source, rather than promoting caller IDs or hashes to authority.
Unknown-tenant denial durability requires its separately allocated narrow
system transaction. General Clerk/session middleware and generic internal
secrets cannot substitute for these boundaries.

Receivers independently compare the exact job/request/source and current
native actor/member/Clerk/client access; the token's signed tenant is only a
routing hint. Preserve operation/body/phase replay fencing in the same
transaction as each actual domain transition. Meri acceptance additionally
requires independent observation of the original accepted request, genuine
issuance, protected facts and accepted run. Completion requires original
retained object/journal custody and exact saved versioned result bytes. These
observations cannot be manufactured from Core's own acceptance ledger.

New human consent creates a new exact operation, never renews an old job,
claim, publication, acceptance or delegation. Each effect must remain bounded
by the earliest applicable original ceiling and current control/source checks.
Cancellation, revocation and actor changes cannot be repaired by relabeling
the original actor or substituting a new request proof. Separate terminal
bookkeeping authority never restores an expired effect grant. Network,
context and model work remain outside database locks; continuation after
browser closure needs server-owned durable execution, not a retained browser
bearer. Ordinary chat remains independent of missing Objective authority.

## Public output boundary and frontend receiving

PR56 generation/status and Planner project receipt discovery contracts remain
unchanged. Frontend PR69 commit `f81f7597` / tree `07925ce` is a pure current-only
PR56 decoder; it does not supply the missing Strategy owner or transport.
No new public route is allocated in this slice.

Public Strategy discovery requires the genuine saved-generation reconstruction
under the CURRENT requesting viewer's native tenant/client/Objective and
resource access, plus the independently established original Meri custody.
The existing private retained-read fence is tied to the original native/Clerk
actor and cannot authorize a different current reader. Reserved Strategy IDs,
matching snapshots or a current title/type cannot replace producer provenance.
Report this missing binding explicitly; an empty data result alone does not
establish unavailability or absence.

Browser selectors may be projected only after custody and current visibility
checks. Requested current source and older accounted source remain distinct;
saved creation provenance remains distinct from current resource version and
availability. Withhold inaccessible IDs, titles, type/version metadata and
private operation/attempt/run/fingerprint/consent/delegation/owner identities.
Recheck current access before navigation.

A separate bounded task-discovery slice can intersect exact v2/v3 materialized
task IDs and retained `taskIndex` from the complete paired Planner owner chain
with the shared current task ACL reader. Project membership scans also include
manual tasks and cannot establish generated provenance. A v3 application with
zero newly created projects is valid receiving input; it must not be forced
through legacy fresh-creation counts.

## Qualification required before later activation

Future qualification must cover exact replay/conflict, concurrent intake and
legacy claim exclusion, rollback and hidden/orphan evidence, source/control
changes, membership/Clerk/client-wall revocation, bounded complete inventory,
browser-closed continuation and immutable original deadlines. Native checks
must use the restricted runtime role and prove immutable ledgers work without
UPDATE/DELETE grants. Current source tests simulate that privilege boundary;
they do not execute SQL or establish real database, transport, SDK or issuer
deployment readiness. Enabled delegation policy, signing/trust configuration,
receiver operation storage and genuine custody ports remain separate gates.
