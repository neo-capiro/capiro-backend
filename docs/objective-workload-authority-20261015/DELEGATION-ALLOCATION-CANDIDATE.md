# Objective generation delegation: disabled schema allocation candidate

Status: source proposal only. No migration ID is reserved, no SQL has been run,
and this document grants no runtime authority. It concerns Objective-triggered
canonical Strategy generation. Ordinary authenticated Meri chat does not read
this table or require this workload credential.

## Migration slot and source

The local Core frontier is
`20281015050000_client_objective_work_reconsent`. Core migration naming requires
a real timestamp after every existing directory and the configured two-year
offset (`apps/api/prisma/migrations/README.md` and
`scripts/migration-timestamp-offsets.json`). The collision-free **local
candidate**, pending central allocation and a fresh remote/worktree scan, is
`apps/api/prisma/migrations/20281016010000_client_objective_workload_delegations/migration.sql`.
No `20281016*` Core directory exists in this checkout. The 15th-day
`40000` Engagement reservation is occupied even though absent locally; the
existing `10000`, `20000`, `30000`, and `50000` directories must not change.
This checkout lacks `origin/main`, so the candidate is not a remote clearance.

The source of consent is the immutable
`client_objective_work_consents` row created by migration `20281015050000`.
Reconsent creates a successor consent and control version under the same root
intent. A delegation therefore binds one **exact consent/action and exact
generation job**, never only the root intent. The queued job source is
`sp_draft_job`; the Core table may not invent a run before genuine Meri
acceptance.

## Proposed Core row

Create `client_objective_workload_delegations` with these closed fields:

| Column | Proposed type and rule |
| --- | --- |
| `delegation_ref` | UUID primary key, Core generated |
| `tenant_id`, `client_id`, `objective_id` | UUID NOT NULL, exact consent scope |
| `work_action` | VARCHAR(40) NOT NULL, CHECK equal to `objective.strategy.draft` for this first slice |
| `control_id`, `consent_id` | UUID NOT NULL, composite FK with scope/action to immutable consent identity |
| `control_version` | INTEGER NOT NULL, positive version observed when job was authorized |
| `generation_job_id` | UUID NOT NULL UNIQUE, actual queued `sp_draft_job.id` |
| `generation_request_id` | UUID NOT NULL, actual stored `objectiveGeneration.request.requestId` |
| `generation_request_fingerprint` | CHAR(64) NOT NULL, lowercase SHA-256 of the stored typed request |
| `job_request_key` | TEXT NOT NULL, exact stored `objective-v1:<hash>` key |
| `clerk_user_id` | VARCHAR(128) NOT NULL, exact queued job owner; native actor and membership derive from consent |
| `service_subject`, `audience` | bounded strings fixed to `capiro-objective-generation-worker:v1` and `capiro:objective-strategy-api:v1` for the first generation slice |
| `policy_revision` | CHAR(64) NOT NULL, lowercase SHA-256 of the reviewed workload policy |
| `issued_at`, `absolute_expires_at` | TIMESTAMPTZ(6) NOT NULL, database times; absolute ceiling no later than original consent confirmation + 24 hours |
| `authority_version` | INTEGER NOT NULL DEFAULT 1, positive CAS fence |
| `enabled` | BOOLEAN NOT NULL DEFAULT false |
| `cancelled_at` | TIMESTAMPTZ(6) NULL, database time of an explicit delegation cancellation |

The composite FK is exactly
`(tenant_id,client_id,objective_id,work_action,control_id,consent_id)` to
`client_objective_work_consents(tenant_id,client_id,objective_id,work_action,control_id,id)`.
Add unique `(tenant_id,consent_id,generation_request_id)` so a request under
one consent cannot gain a second job delegation. Check UUID-independent fields
for nonblank length, positive version, lowercase hash, and
`issued_at < absolute_expires_at <= issued_at + interval '24 hours'`.
The writer must additionally enforce the earlier consent-confirmation ceiling
under lock; a CHECK cannot reference the consent table. Preserve the row's
scope/job/request/subject/time identity on update; only guarded
`authority_version`, `enabled`, and `cancelled_at` transitions may change.

Do not add an unqualified cross-schema FK to `sp_draft_job`. The transaction
that creates this disabled row must lock and compare the real queued job,
with exact tenant/client/Clerk owner, request ID/fingerprint/key, deadline,
`attempt=1`, null claim fields, and null Strategy ID. Shared database role,
lock order, grants, and cross-schema FK feasibility require native proof.
No row is created from a browser receipt, missing row, static service secret,
or merely successful consent.

Enable and FORCE tenant RLS using the existing
`rls_bypass()/current_tenant_id()` pattern. No broad application grant or
new role is proposed. Keep direct DELETE/TRUNCATE unavailable, and keep
`enabled=false` until the authenticated issuer, controlled transition writer,
and native privilege checks are allocated. A scalar Prisma mirror is optional:
the consent/control tables are presently owned by raw SQL.

## Replay, revocation, and phase behavior

- Exact replay of delegation creation for the same job, consent, request ID,
  fingerprint and key returns the original row. Any mismatched value under a
  reused job or consent/request key is a conflict; no second reference is
  minted. An unknown job enqueue/ACK is reconciled to its original job before
  any retry. A new explicit reconsent has a new consent ID and needs a new
  exact job; it never renews the old run.
- Before Meri acceptance, there is no run/attempt/writer-fence value to store.
  After authenticated Meri readback, the existing immutable Core
  `GENERATION_ACCEPTANCE` ledger supplies that binding. An effect transaction
  compares its issuance key, request/facts hashes, run binding and original
  expiry against the actual `sp_draft_job` claim (`attempt=2`,
  `claimed_by=canonical:<issuanceKey>`), the exact current consent/control,
  native actor and membership ID, tenant/client wall, Objective source,
  canonical target and post-lock database clock.
- Effect eligibility ends at the earliest original consent, job, request-bound
  token and Meri issuance deadlines. A cancellation or reconsent advances the
  control fence; every later effect check denies the old consent even if a
  signed token has not expired. A revoked token never substitutes for the
  database fence. No model or remote I/O occurs under those locks.
- `terminal-account` uses a **different fresh bookkeeping authorization**,
  exact historical job/accepted-run lineage and current actor/membership,
  client and source checks. It may append only an immutable, deduplicated
  non-success outcome when no successful completion or Strategy write is
  present. Old effect/worker/consent deadlines remain historical and are not
  renewed. Cancellation or successor consent does not erase the old outcome;
  uncertain evidence remains `outcome_unconfirmed`. This purpose is bounded
  by the original delegation's 24-hour ceiling and its own short token life.

Request-bound JWT issuance, signature verification and operation-level `jti`
deduplication are separate source allocations. A unique job row alone cannot
make HTTP phase replay safe; existing admission/publication/terminal ledgers
must return the exact committed result on identical replay and reject changed
payloads under the same operation identity.

## Concrete issuance mechanism proposed for review

Use a Core-owned, issuer-minted **authorization JWT**, not a normal Clerk or
OIDC identity token decorated with caller claims. The first implementation
candidate uses Node `crypto` RS256 with an issuer-only RSA private PEM key of
at least 3072 bits. Deployment/security owns key generation, private-key
custody, issuer naming and rotation. Strategy and Meri pin trusted versioned
public keys by exact `kid` in configuration; allow only RS256, reject unknown
or retired keys and all token-supplied `jwk`, `jku`, `x5u` and key URLs. No
issuer route, key, secret, environment setting or trust store is configured
by this proposal. KMS signing is a later adapter choice requiring separate
dependency/IAM/CDK review, not a hidden prerequisite for source fixtures.

Proposed private issuance route:
`POST /internal/objective-workload-authority/decisions`, no query. A named
Meri worker or separate terminal accountant first presents a
separately signed, request-bound proof from its own pinned key pair. Core maps
the verified issuer-qualified proof subject to a fixed permission table,
then locks and reads the exact delegation, consent/control, job and current
source. A caller-selected audience, actor, action, phase, job or SHA claim is
never promoted to an authorized Core fact. Core mints one JWT scoped to one
target service, concrete method and path, phase, original job, immutable
request/accepted-run binding when present, and SHA-256 of the **transmitted
body bytes**. GET binds the empty-body hash and the concrete job-ID path.
Queries and non-identity content encoding are forbidden on these routes.
Any future Strategy-to-Meri continuation obtains its own Meri-audience token;
it does not forward a Meri token addressed to Strategy. Core obtains its exact
retained-reader token locally through the same issuer policy.

The caller proof is a **different JWT type**:
`typ=capiro-objective-workload-proof+jwt`, RS256, one pinned caller `kid`,
environment-qualified caller `iss`, exact named `sub`,
`aud=capiro:objective-core-issuer:v1`, `jti`, `iat`/`nbf`/`exp` with at most
30-second life, `operationId` UUID, `method=POST`, the concrete issuance path,
empty query and SHA-256 of the raw issuance-request bytes. Core pins each
caller's public key to its subject and allowed phases independently of proof
claims, rejects token-supplied key material/URLs, and checks proof-jti replay
under the issuance transaction. This proof authenticates a caller to the
issuer; it is never a target-service authorization or user delegation.

The closed issuance request carries the original `operationId`, requested
phase/job, concrete target method/path and **target body bytes** (base64url,
bounded; empty for GET), not a claimed target-body digest. Core decodes,
parses and compares those bytes with the fixed route and durable source or
accepted Meri readback, computes its own target body SHA-256, and rejects
anything it cannot establish. The caller sends those identical bytes to the
target. The proof covers the whole issuance request exactly as transmitted.
No caller-supplied tenant, actor, membership, consent ID, deadline, token
audience or hash can override Core's stored values.

The first fixed target audiences are `capiro:objective-strategy-api:v1` for
generation and terminal routes, and
`capiro:objective-meri-retained-result:v1` for the Core retained-result reader.
The named subjects are `capiro-objective-generation-worker:v1`, the separate
`capiro-objective-terminal-accountant:v1`, and
`capiro-objective-core-result-reader:v1`. Their route/phase allowlist is
closed in the source-only JWT fixture contract. A future Strategy-to-Meri
continuation needs its own audience and authorization allocation.

The signed header has a fixed workload `typ`, `alg=RS256`, and trusted `kid`.
The signed payload has exact environment-qualified `iss`, named `sub`, one
target `aud`, unique UUID `jti`, bounded integer `iat`/`nbf`/`exp` (at most
60 seconds), operation/phase, delegation/consent/job identity, concrete
method/path, empty-query marker, and lowercase raw-body SHA-256. Each target
verifier pins the expected issuer, subject, audience, `kid`, algorithm,
operation/phase and actual route; recomputes the hash from captured raw bytes;
and checks time with zero skew in the current fixture. Any later clock-skew
policy must never extend database effect deadlines. Strategy's current global
JSON parser does not capture raw bytes,
so its Objective-only ingress needs a scoped capture/verify step before JSON
parsing. Meri's new retained-read ingress needs the same behavior. Missing
issuer/key configuration returns Objective-specific authority unavailable and
must not fail process startup or ordinary chat.

Issuer issuance and each verifier's effect transition need atomic replay
records. An immutable operation identity includes issuer, subject, audience,
`jti`, method, path, body SHA, phase and job, plus the eventual result
reference/hash. Exact replay under current read authority returns the saved
result; altered replay conflicts; in-progress/unknown outcomes reconcile the
same original operation instead of allocating a new `jti` or effect. The
record and domain transition commit together under the existing job/phase
CAS, or an outside-transaction context step reserves a bounded in-progress
identity before work. A freshly signed token with a different `jti` still
cannot repeat a completed job phase. The exact ledger table/constraint and
cross-service transaction ownership need separate allocation before any
route is enabled. Meri retained reads additionally recheck the accepted run,
journal/object custody and current identity; the Core reader subject by
itself never selects a result.

One concrete Core issuance-ledger candidate, subject to the same central
migration allocation, is `client_objective_workload_issuances`: immutable
`operation_id` UUID unique with service subject, proof `jti` UUID unique,
authorization `jti` UUID unique, delegation/job/consent scope, fixed
phase/method/path, body SHA-256, accepted-binding SHA-256 or null, signer
`kid`, and DB `iat`/`nbf`/`exp`. Lock/insert this row with the source decision.
An exact request replay uses its original claims and RS256 key to reproduce
the same deterministic JWT while unexpired; a changed request conflicts. If
the original signing key is unavailable or the token expired, return
unavailable or its saved terminal decision, never mint a successor under that
operation ID. No raw bearer is stored. Strategy's separate verifier ledger
must uniquely bind `(iss,sub,aud,jti)` to the actual phase/body/job and its
committed domain receipt in the same local transaction. Meri's retained-read
owner needs the corresponding durable read-replay record and fresh custody
check. Neither ledger exists today; their SQL/lock ownership remains a HOLD
gate, rather than an implied property of the cryptographic fixture helper.
