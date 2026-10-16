# Objective work cancellation and explicit reconsent

## Superseding implementation allocation, 2026-10-16

The parent has now **centrally reserved exclusively** `apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql` for this owner. The historical 15-head/12-worktree collision scan found no 50000 directory; 10000/20000/30000 and Engagement 40000 remain preserved. The three tables and commands below are now implemented as source, without migration execution. The older UNRESERVED/proposal statements below describe the earlier checkpoint, not current authority.

The parent explicitly selected a **new** product policy: `capiro.objective-generation-consent`, integer revision **1**, default/max configured duration **1,800,000 ms (30 minutes)** for `objective.strategy.draft` and `objective.plan.prepare`. Configuration may reduce it; an increase requires an explicit policy revision. The existing stricter tenant/action/token/delegation expiry limits still reduce the effective duration. There is no 24-hour default, and neither model/budget/token lifetime supplies human consent. The pure Core policy lives at `apps/api/src/auth/workload-authority/objective-consent-policy.ts`. This supersedes the prior search for a legacy duration binding and the earlier proposed CHAR(64) policy revision/24-hour effective maximum. The actual SQL uses INTEGER policy revision 1 and configured/effective durations at most 1,800,000 ms.

Current source: `apps/api/src/clients/objectives/work/` implements the exact authenticated command/read boundary. Owner reconciliation and stricter-settings facts remain explicitly unconnected and fail closed; their absence cannot establish not_started, authorize retry, or allocate a fresh effect identity. A successful consent record never creates a workload credential or dispatches a model. The API-Strategy receiving allocation is detailed in `../RECEIVING-TRUST-ALLOCATION.md`.

## Historical proposal checkpoint (superseded where stated above)

Source-only proposal against Core `622905839c7a510ab01a512ef8012926b2e1b4ce`. No application, Prisma schema, migration, test or runtime change is made here. The parent has resolved policy: a currently authorized Objective writer may explicitly reconsent for the exact current ready revision/action without editing the Objective; retain original and new actor lineage, preserve every old expiry, and never retry an UNKNOWN outcome. Existing action-consent duration applies, capped at 24 hours and every stricter applicable limit. **24 hours is a ceiling, never a default duration.**

## Existing boundaries

- `20281015010000_client_objective_work_intents`: immutable pending-only root intent, unique by ready revision/purpose; no expiry or cancel/retry transition exists in that table. Keep it unchanged.
- `20281015020000_client_objective_canonical_plans`: stable reserved Strategy/project IDs, current requested source, positive binding CAS, epoch 1. Reservations are not outputs. Keep its existing source migration unchanged.
- `20281015030000_client_objective_operational_links`: useful precedent for exact scoped FKs, current-authority receipt recovery, actor/request UUID uniqueness, append-only receipts and FORCE RLS. Reconsent does not reuse association receipts as workload authority.
- `objective-work-intent.ts` and `objectives.service.ts:196`: repeated ready confirmation remains a no-op; do not manufacture an Objective edit/version to obtain new consent.
- `workload-authority.policy.ts:236-248,294-324`: the old absolute expiry remains binding, including retained workload lookup. This proposal does not weaken it or renew an old worker/run.

The older workload proposal's one-delegation-per-root-intent model needs an explicit additive amendment: each new reconsent has its own stored authorization-request identity. Never overwrite the old delegation or reinterpret its original confirmation time. A future versioned workload binding must include this new identity; its original/current actor is the new consent's actor/membership, while the original ready-intent actor remains separate immutable lineage.

## Minimal public command and read

Use the existing authenticated Core browser/tenant/role boundary and the actual current Objective-writer policy. No caller-supplied actor, tenant, membership, deadline or consent duration is accepted.

`POST /clients/:clientId/objectives/:objectiveId/generation/commands`

Closed body:

```json
{
  "schemaVersion": 1,
  "requestId": "UUID",
  "command": "retry | cancel",
  "workAction": "objective.strategy.draft | objective.plan.prepare",
  "expectedObjectiveVersion": 1,
  "expectedControlVersion": 0,
  "expectedCanonicalBindingVersion": 1,
  "targetAuthorizationRequestId": "UUID or null"
}
```

UUIDs are normalized; versions are bounded integers. Control version 0 and a null target mean no reconsent control head yet, not proof that no original operation exists. The server derives and validates the root intent, exact immutable ready revision/hash, canonical binding/epoch and reserved targets. `workAction` is an exact closed operation, not a general capability or approval for assistant edits, documents, activation or external sending.

`GET /clients/:clientId/objectives/:objectiveId/generation?workAction=...&requestId=...`

`workAction` is required; `requestId` is optional. Without it, return the minimal current source/control/consent-expiry/reconciliation view. With it, recover that actor's exact immutable command receipt under fresh current authority; do not turn a historical receipt into current write permission. GET never dispatches, reconciles by writing, retries or changes expiry. IDs of unavailable owner outputs remain redacted. A public command receipt is not a credential or proof that generation/Planner publication applied.

Successful command receipt: schema version, request ID/digest, command/workAction, exact command Objective revision/version, result control version, target/new authorization-request IDs as applicable, consent confirmation/expiry for retry only, outcome (`reconsent_recorded`, `cancellation_recorded` or `unchanged`) and DB commit time. Return original committed bytes on exact replay. Source/control/payload conflicts use 409; current scope denial remains uniformly unavailable. Missing authoritative consent policy or owner reconciliation evidence is unavailable, never an assumed grant.

## Minimal additive records

Three Core tables suffice; they record consent/control, not a second scheduler or model-output store. Names below are proposed, not allocated application tables.

| Record | Required identity and constraints |
|---|---|
| `client_objective_work_controls` | One row per tenant/client/Objective/workAction; immutable scope, canonical binding ID and exact action; version starts at 0; nullable current authorization-request ID; cancellation fence/time. CAS changes only current head/fence/version and DB update time. |
| `client_objective_work_consents` | Append-only ID; scope/action; root intent + ready revision ID/version/hash; canonical binding ID/version/epoch + reserved target IDs; previous authorization-request ID when present; original root-intent actor; newly consenting native actor and exact membership ID; existing consent-policy ID/revision and original configured duration; effective duration/expiry and applicable ceiling provenance; DB confirmation time; command request/digest correlation. Multiple explicit consents may reference the same unchanged root intent/revision. |
| `client_objective_work_command_receipts` | Append-only actor/request UUID identity; normalized complete command + digest; exact command source revision; target/result authorization-request IDs; before/after control versions; outcome; DB commit time. Composite FKs retain tenant/client/Objective/action/canonical lineage, not just matching UUIDs. |

Persist original and new actors separately: a different currently authorized writer does not become the historical ready-revision author. Do not copy a new actor onto an old intent/attempt. Membership deletion/recreation is not continuation of the old membership identity.

Attempts remain owned by the consuming operation ledger. Each actual attempt must have an immutable attempt identity, consent-request/action/source/canonical binding, request fingerprint, original run/job identity and original deadline; transitions/results append original-identity receipts rather than rewrite those facts. A worker reclaim/lease claim is a separate fence. Do not allocate an invented run/result receipt just because Core recorded reconsent. The owner adapter/immutable attempt binding must be allocated before runtime admission; the separately coordinated Meri/Planner proposal is not an implementation of it.

## Consent duration

Resolve the **existing action-consent policy**, not a new Objective default and not a number supplied by the browser:

```text
newExpiry = min(
  dbConfirmedAt + existingPolicy.durationForExactAction,
  dbConfirmedAt + 24 hours,
  every stricter applicable new-consent policy/authority absolute limit
)
```

Require a known positive bounded duration, exact current policy revision and an expiry strictly after the post-lock DB clock. Store duration provenance and the effective result. An absent/unavailable duration policy blocks creation; no fallback to 24 hours. Existing Core Objective/workload source does not identify this duration adapter, so its authoritative owner/locator is an implementation wiring requirement. The parent's business choice is resolved; inventing a numeric default is not an acceptable substitute.

The old consent/intent/attempt/run expiry is never changed or used as the new consent's start time. New consent does not renew an old run, extend a claim, permit a late old publication or convert a retained read into an effect lease. Existing per-action worker/decision bounds remain separately enforced and may be stricter.

Owner reconciliation (2026-10-16): the Meri Planner owner inspected `b8b75414340fc6e0367f50dbefdb01c3830f823b` / tree `241bb5eaa6376e1071770f0ede46feaa1529aefb`, directly after `cf639d4707df0060524218c65d941834ed7ea2e3`. Neither Objective action has an accepted configured-duration binding in that inspected source. `apps/control/intents/command-preparer.mjs` maps only `create_task` to `task.create`; `apps/control/commands/approval-metadata/owner.mjs` consumes an injected `preparePolicy` expiry instead of supplying such a registry. Budget expiry and token/Temporal lifetimes cannot substitute. The later shared joint `f54` baseline was not in that owner's object store, so this is not a claim about every unseen branch. Allocation must name the authoritative existing policy/action alias, policy ID/revision and configured milliseconds, or explicitly allocate the missing action bindings; issuance stays unavailable meanwhile.

## Transaction and UNKNOWN handling

1. Parse the closed command and digest its full normalized identity, including action, expected versions and target request. Resolve current native actor/membership, permitted role, active tenant/client and current wall from authoritative rows. Both actions bind the exact current Objective version; retry additionally requires its exact current ready revision/root intent/hash. Cancellation may fence an expired request without using its expired workload grant.
2. Recover an existing actor-scoped command receipt under current authority before expected-version CAS. Exact digest returns the original receipt; same UUID/different command is 409. Recovery alone creates no new consent/effect.
3. Follow the existing lock direction: consuming owner resource/claim when applicable, then Core authority/Objective, then canonical/control. Serialize a missing control via its scoped unique key, lock its head, recheck replay and compare control/canonical versions, current action and target. Immutable intents/consents remain SELECT/INSERT-only; lock the mutable head, not those immutable rows. Use `clock_timestamp()` after relevant locks; no provider/HTTP/model work under locks.
4. Before retry, require authoritative accounting of the **same original operation**: immutable attempt/run/fingerprint and original terminal/application receipt. A missing ACK, absent receipt, timeout, in-flight/unresolved operation or UNKNOWN outcome is not known failure. Return `OUTCOME_UNCONFIRMED`; do not advance the head or allocate new consent/attempt/run/operation identity. Caller claims and unrelated receipts cannot satisfy this check. Reconcile/recover that original receipt first, then make a fresh explicit retry command if appropriate.
5. Once the original outcome is accounted for and fresh policy/current-ready checks pass, append the new consent and CAS the control head/version, then append its command receipt in the same transaction. Retry retains canonical IDs/epoch and does not alter applied history or Objective content/version. A second different request with the same expected control version loses CAS; it must reload rather than mint another attempt automatically.
6. Cancellation advances the same authority fence and appends a cancellation receipt atomically, even after consent expiry. Repeated cancellation can yield an immutable `unchanged` receipt without advancing the head again. Cancellation may fence an UNKNOWN operation but does not assert it never committed or that a remote worker stopped; retain the unresolved original outcome, and keep retry blocked until its original receipt is accounted for. Do not delete outputs/history or label already-published work undone.
7. Every eventual owner publication must verify the exact current control/consent/authority version, current Objective/revision/action/canonical target and original attempt/claim/deadline within its own effect transaction. Cancellation and publication serialize on the same fence where storage is shared. This proposal establishes no cross-database atomic revocation. A receipt/head/consent failure rolls back the whole local command.

## Migration and implementation allocation

Suggested number: **`20281015050000_client_objective_work_reconsent` — UNRESERVED**. `COLLISION-SCAN.json` records the bounded local scan. Existing 10000/20000/30000 are occupied; the parent's Engagement 40000 reservation remains occupied even though absent from inspected local trees. Parent allocation and a fresh collision check must precede any application migration directory.

Future additive migration: create the three records with exact scoped FKs, positive/bounded versions and durations, coherent nullable groups, unique actor/request receipt keys and unique control scope/action. Add only the necessary scoped referenced uniqueness to existing tables; do not edit old migration files, relax their pending/epoch constraints or create `sp_*` output FKs for reservations. Enable/FORCE tenant RLS on new tables; use immutable-row guards and revoke application UPDATE/DELETE on consent/receipt rows. Preserve existing Objective-cascade retention semantics. Actual migration-owner/default grants, roles and native concurrency still require qualification; no privilege expansion is proposed here.

Future owner files: cohesive `clients/objectives/objective-work-control` command rules/types, store and service; existing Objective controller/module DTO wiring; additive Prisma models/migration; a versioned workload binding/fact adapter that pins consent identity; consuming Strategy/Planner final-transaction adapters. Existing operational associations remain separate. Public browser reconsent is not workload service authentication, and this proposal enables no dispatcher/provider/continuation.

Focused proof obligations after implementation: exact replay/UUID conflict; two-writer CAS; fresh membership/wall/source/policy revocation; reused stricter action duration and missing-policy denial; expiry-boundary cancellation; UNKNOWN retry denial and original-receipt recovery; immutable original/new actor and attempt lineage; cancellation/publication race; rollback on receipt failure. None was executed or newly accepted by this proposal.

## Git documentation successor: exact additive contract

This appendix is a documentation-only successor on `5afc530a6907c74b21db3ea59103def6cb5a20a5`. The preceding proposal was copied byte-for-byte from evidence SHA256 `f755832942294c4d8f60160985816a74b120f7449984817965f9cd6bc862772d`; the external original remains unchanged. No implementation/schema/migration file is created or changed.

**Full proposed migration path: `apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql` — UNRESERVED/PENDING ALLOCATION.** Existing 10000/20000/30000 and the known Engagement 40000 reservation remain occupied. The local 15-head/12-worktree scan found no 50000 directory; this is historical local evidence, not allocation or a remote guarantee. Refresh immediately before the parent allocates/creates the migration.

### Exact proposed fields and constraints

The following are concrete proposed SQL column types, not executable DDL. `S` expands to the exact four columns `tenant_id UUID NOT NULL, client_id UUID NOT NULL, objective_id UUID NOT NULL, work_action VARCHAR(40) NOT NULL`. Every `work_action` is constrained to `objective.strategy.draft` or `objective.plan.prepare`. Every table has `S`; `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`; FORCE tenant RLS using the existing `rls_bypass()/current_tenant_id()` policy; and no application direct DELETE. All source/hash/policy digests are lowercase SHA256 `CHAR(64)` with `^[0-9a-f]{64}$`. Every INTEGER version is bounded by PostgreSQL INTEGER; increments at 2147483647 fail, never wrap.

`P` expands to `canonical_plan_id UUID NOT NULL, canonical_epoch INTEGER NOT NULL CHECK (=1), canonical_strategy_id UUID NOT NULL, canonical_project_id UUID NOT NULL`. These remain private reservation lineage, not output locators. All three new tables contain `P`.

`R` expands to `root_intent_id UUID NOT NULL, source_revision_id UUID NOT NULL, source_objective_version INTEGER NOT NULL CHECK (>0), source_snapshot_hash CHAR(64) NOT NULL, root_actor_user_id UUID NOT NULL`. Consent and receipt rows contain `R`; these identify the work's saved ready source, separately from the command's current Objective revision.

| Proposed table | All additional columns beyond `id`, `S`, `P` and indicated `R` |
|---|---|
| `client_objective_work_controls` | `version INTEGER NOT NULL DEFAULT 0 CHECK (>=0)`; `current_consent_id UUID NULL`; `cancelled_at TIMESTAMPTZ(6) NULL`; `cancelled_by_user_id UUID NULL`; `created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()`; `updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()`. No `R` columns: each immutable consent/receipt carries its own source. |
| `client_objective_work_consents` | Includes `R`. `control_id UUID NOT NULL`; `previous_consent_id UUID NULL`; `consenting_actor_user_id UUID NOT NULL`; `consenting_membership_id UUID NOT NULL`; `canonical_binding_version INTEGER NOT NULL CHECK (>0)`; `consent_policy_id VARCHAR(128) NOT NULL`; `consent_policy_revision CHAR(64) NOT NULL`; `configured_duration_ms BIGINT NOT NULL CHECK (BETWEEN 1 AND 9007199254740991)`; `effective_duration_ms BIGINT NOT NULL CHECK (BETWEEN 1 AND 86400000)`; `stricter_expires_at TIMESTAMPTZ(6) NULL`; `stricter_limit_ref VARCHAR(128) NULL`; `confirmed_at TIMESTAMPTZ(6) NOT NULL`; `expires_at TIMESTAMPTZ(6) NOT NULL`; `command_request_id UUID NOT NULL`; `command_receipt_id UUID NOT NULL`; `payload_digest CHAR(64) NOT NULL`. |
| `client_objective_work_command_receipts` | Includes `R`. `control_id UUID NOT NULL`; `actor_user_id UUID NOT NULL`; `actor_membership_id UUID NOT NULL`; `request_id UUID NOT NULL`; `payload_digest CHAR(64) NOT NULL`; `command JSONB NOT NULL CHECK (jsonb_typeof(command)='object')`; `command_kind VARCHAR(8) NOT NULL CHECK (IN ('retry','cancel'))`; `command_revision_id UUID NOT NULL`; `command_objective_version INTEGER NOT NULL CHECK (>0)`; `canonical_binding_version INTEGER NOT NULL CHECK (>0)`; `control_version_before INTEGER NOT NULL CHECK (>=0)`; `control_version_after INTEGER NOT NULL CHECK (>=0)`; `target_consent_id UUID NULL`; `created_consent_id UUID NULL`; `result_consent_id UUID NULL`; `outcome VARCHAR(24) NOT NULL CHECK (IN ('reconsent_recorded','cancellation_recorded','unchanged'))`; `committed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()`. |

Exact proposed unique keys/FKs, with `S/P/R` expanded as above during eventual implementation:

- Existing canonical table: additive `UNIQUE (tenant_id,client_id,objective_id,id,epoch,canonical_strategy_id,canonical_project_id)`. Each control's `(tenant_id,client_id,objective_id,P)` references these columns in matching order. Do not include mutable `binding_version` in a historical FK: its equality is a locked transaction/CAS check, while its observed value remains stored in each immutable record.
- Existing intent table: additive `UNIQUE (tenant_id,client_id,objective_id,id,objective_revision_id,objective_version,snapshot_hash,actor_user_id)`. Each consent/receipt's `(tenant_id,client_id,objective_id,R)` references that key in matching order. This pins the original ready actor as well as exact source/hash. Existing migration files are not edited.
- Controls: `UNIQUE(S)` and `UNIQUE(S,id,P)`. Consents/receipts: `(S,control_id,P)` FK to the latter key. Control scope, action and `P` are immutable. A control's cancellation time/actor must be either both null or both nonnull; version 0 has null head and cancellation pair. Cancellation of an original root may advance the fence while the head remains null.
- Consents: `UNIQUE(S,control_id,id)`, `UNIQUE(S,consenting_actor_user_id,command_request_id)`, and `UNIQUE(S,control_id,command_receipt_id)`. `previous_consent_id` has a nullable `(S,control_id,previous_consent_id)` self-FK to `(S,control_id,id)`; it cannot equal its own ID. `(S,id,current_consent_id)` on controls references consent `(S,control_id,id)`; initial control insertion has a null head, then consent insertion and head CAS occur in one transaction.
- Receipts: `UNIQUE(S,actor_user_id,request_id)` and `UNIQUE(S,control_id,id)`. Each nonnull target/created/result consent has `(S,control_id,<consent_id>)` FK to consent `(S,control_id,id)`. `(tenant_id,client_id,objective_id,command_revision_id,command_objective_version)` references the existing revision scope key. `(S,control_id,command_receipt_id)` on consent references receipt `(S,control_id,id) DEFERRABLE INITIALLY DEFERRED`; a receipt/consent pair is inserted atomically. Scope FKs preserve existing Objective cascade deletion semantics and use `ON UPDATE NO ACTION`.
- Consent/receipt application UPDATE, DELETE and TRUNCATE are revoked and BEFORE UPDATE immutable guards reject mutation. Controls also revoke application DELETE and TRUNCATE. This does not qualify inherited/owner/PUBLIC privileges: the nonowner role posture, effective ACLs and FORCE RLS require separate native proof, without granting new roles or access. A deferred consistency guard checks each created consent's reciprocal retry receipt, actor/request/digest, source/action/control/canonical pins and result ID. The command parser validates closed JSON and its digest on write and recovery; matching UUID alone never makes a valid receipt.
- A retry receipt has `created_consent_id=result_consent_id IS NOT NULL`, outcome `reconsent_recorded`, and after-version=before-version+1. A cancellation has null created-consent ID, result-consent ID equal to its target (including both null for the original root), and outcome `cancellation_recorded` with +1 or `unchanged` with equal versions. No other combination is permitted.
- Actor/membership UUIDs are immutable audit identities resolved from current rows inside the authority transaction; do not add a deletion-blocking FK to membership/user rows just to preserve audit identity. Root actor equality is enforced by the exact root-intent FK. The original root intent did not store an original membership ID, so do not invent one by rereading today's membership; the new consent stores its own exact membership and retains prior-consent lineage.

`effective_duration_ms <= configured_duration_ms`; expiry is strictly after DB confirmation, within effective duration, within 24 hours, and no later than `stricter_expires_at` when present. Stricter time/ref are both null or both nonnull; IDs/refs are nonempty within stated lengths. Derive the effective whole-millisecond duration conservatively from the post-lock DB clock and existing policy, rounding expiry down when necessary, never extending a stricter boundary. Store the actual selected expiry/provenance. No duration fallback/default or browser-controlled deadline exists.

### Full closed wire shapes

Every object below is closed: all listed keys are required unless marked optional, unknown keys are rejected recursively, and nullable values are explicit. UUID=`normalized UUID string`; SHA=`64 lowercase hex`; Time=`valid server UTC ISO timestamp`; Int=`integer in [1,2147483647]`; Version=`integer in [0,2147483647]`; Action=`objective.strategy.draft | objective.plan.prepare`.

```ts
type Command = {
  schemaVersion: 1;
  requestId: UUID;
  command: 'retry' | 'cancel';
  workAction: Action;
  expectedObjectiveVersion: Int;
  expectedControlVersion: Version;
  expectedCanonicalBindingVersion: Int;
  targetAuthorizationRequestId: UUID | null;
};
type Revision = { id: UUID; version: Int };
type ConsentTimes = { id: UUID; confirmedAt: Time; expiresAt: Time };
type CommandReceipt = {
  schemaVersion: 1;
  receiptId: UUID;
  requestId: UUID;
  payloadDigest: SHA;
  clientId: UUID;
  objectiveId: UUID;
  command: 'retry' | 'cancel';
  workAction: Action;
  commandRevision: Revision;
  sourceRevision: Revision;
  rootIntentId: UUID;
  controlVersionBefore: Version;
  controlVersionAfter: Version;
  targetAuthorizationRequestId: UUID | null;
  authorizationRequestId: UUID | null;
  consent: ConsentTimes | null;
  outcome: 'reconsent_recorded' | 'cancellation_recorded' | 'unchanged';
  committedAt: Time;
};
type ReadQuery = { workAction: Action; requestId?: UUID };
type GenerationRead = {
  schemaVersion: 1;
  clientId: UUID;
  objective: { id: UUID; revision: Revision; status: 'draft' | 'in_review' | 'ready' };
  workAction: Action;
  control: { version: Version; currentAuthorizationRequestId: UUID | null; cancelledAt: Time | null };
  consent: (ConsentTimes & { expired: boolean }) | null;
  reconciliation: 'not_started' | 'accounted' | 'outcome_unconfirmed';
  commandReceipt: CommandReceipt | null;
  observedAt: Time;
};
type SafeError = {
  schemaVersion: 1;
  requestId: UUID | null;
  code: 'INVALID_REQUEST' | 'NOT_AVAILABLE' | 'OBJECTIVE_VERSION_CONFLICT'
    | 'CONTROL_VERSION_CONFLICT' | 'CANONICAL_VERSION_CONFLICT'
    | 'REQUEST_ID_CONFLICT' | 'OUTCOME_UNCONFIRMED' | 'AUTHORITY_UNAVAILABLE'
    | 'RECEIPT_UNVERIFIABLE';
};
```

The POST's entire success body is `CommandReceipt`. A retry's authorization ID equals its nonnull consent ID; a cancel's authorization ID is its result/target ID and `consent=null`. The GET's entire success body is `GenerationRead`; without a receipt query, `commandReceipt=null`; with one, that exact actor-scoped receipt is required or 404 `NOT_AVAILABLE`. Historical receipt recovery uses current admission and does not require the historical expected versions to remain current. The current read's reconciliation requires authoritative owner accounting: an absent job/receipt alone cannot produce `not_started` or `accounted`. Store/return no credentials, raw worker errors, private owner outputs, membership IDs or canonical reserved output IDs in these public shapes.

HTTP mapping: 400 `INVALID_REQUEST`; 404 uniform `NOT_AVAILABLE`; 409 the three version conflicts, `REQUEST_ID_CONFLICT` or `OUTCOME_UNCONFIRMED`; 503 `AUTHORITY_UNAVAILABLE` or `RECEIPT_UNVERIFIABLE`. Identity/current-authority denial uses the same unavailable response without foreign-reference distinctions. Raw diagnostics stay internal. An UNKNOWN original outcome produces no new consent/control advance/operation identity; cancellation may fence it without asserting remote undo. Receipt-read authority after expiry does not revive the old workload grant.
