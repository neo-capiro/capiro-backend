# Selected Strategy intake source contract

Stack base: PR57 `b05918cb7d2c3368b01415e4c40d733e100ad361`.
This additive source slice mounts an authenticated application route but keeps
new intake disabled by default. It does not activate a workload issuer, Meri
receiver, Strategy execution, Planner continuation, migration or deployment.

## Public application boundary

`POST /clients/:clientId/objectives/:objectiveId/generation/strategy-commands`
uses the existing application identity proof and current tenant/client access.
The HTTP application prefix remains the server's existing prefix. There is no
browser workload token, private job selector or caller-selected target.

The body has exactly three keys:

```json
{
  "schemaVersion": 2,
  "command": {
    "schemaVersion": 1,
    "requestId": "00000000-0000-4000-8000-000000000001",
    "command": "retry",
    "workAction": "objective.strategy.draft",
    "expectedObjectiveVersion": 2,
    "expectedControlVersion": 0,
    "expectedCanonicalBindingVersion": 3,
    "targetAuthorizationRequestId": null
  },
  "selection": {
    "type": "appropriations",
    "generationRequestId": "00000000-0000-4000-8000-000000000002"
  }
}
```

Allowed types are `appropriations`, `authorization`, `regulatory`, `coalition`,
`procurement`, `earmark` and `amendment`. Both request IDs are distinct protocol
identities: the first identifies human approval; the second identifies the
typed generation request. Reusing an approval ID with a changed selection is
a conflict. Reusing a generation identity cannot create a second job.

The response is exactly `{schemaVersion:2,commandReceipt,selection}`.
`commandReceipt` retains the existing v1 receipt shape and digest;
`selection` contains exactly `type` and `generationRequestId`. A successful
receipt means consent and a reserved job committed, not generation completed.
Existing error envelopes and HTTP mapping are reused. All responses are
`private, no-store`. The PR53 generation GET and PR56 outputs GET remain frozen.

Only initial Strategy intake is supported: the actual locked Strategy control
must have version zero and no prior consent, with proven absence of relevant
native jobs, canonical output and ambiguous owner receipts. Regeneration,
terminal accounting and automatic pair confirmation remain held. Existing
Planner ownership and ordinary chat do not acquire Strategy approval authority.

## Transaction and durable custody

The actual application transaction records the unchanged native consent,
control CAS and v1 receipt, an immutable selected-type intake, and an actual
fresh `sp_draft_job`. Its deadline is bounded by the original consent; insertion
waits cannot renew consent or request expiry. The job contains no bearer.
The ready Objective revision and its native source/root/canonical binding are
retained. Existing context compilation remains responsible for full client,
relationship and government context; intake does not synthesize that context.

The private `objectiveCanonicalReservation` marker is a worker exclusion marker.
It is not an admission, delegation, claim, accepted Meri request or grant.
Both legacy job creation paths use the same transaction gate. Core locks the
complete bounded tenant job inventory before its native control locks and
refuses contention. Strategy/version identity writers use the same native
nonblocking global Strategy-ID gate, including tenant or identity moves.
An audited existing system read establishes global occupancy without returning
foreign tenant metadata. No RLS bypass function or new privilege grant is added.

One new migration, `20281017010000_client_objective_strategy_intake`, owns the
immutable companion and consistency guards. No earlier migration is changed.
Database guards preserve the reserved input/deadline and refuse legacy claim,
mutation or deletion until an actual matching canonical admission is committed.
These guards establish consistency, not cryptographic authority.

Actual canonical capture compares the original C1 consent, native receipt,
actor, source tuple, selected request and original deadline before atomically
replacing the reservation with its genuine canonical marker. A later C2 cannot
adopt an old C1 job. Snapshot hashes use the existing canonical snapshot
algorithm; typed request/envelope hashes retain their existing separate dialect.

## Default-off policy and compatibility

New writes require all of the following source policies: server
`OBJECTIVE_STRATEGY_INTAKE_ENABLED=true`, a positive bounded
`OBJECTIVE_STRATEGY_CONSENT_DURATION_MS`, tenant
`clioFeatureFlags['strategyPlanner.enabled']===true`, and tenant
`objectiveStrategyIntake.enabled===true`. An optional tenant duration limit
can only shorten the configured duration. This document is not activation
authorization and supplies no live settings or credentials.

The v1 nested command schema, immutable command constraint and digest are
unchanged. Fresh v1 untyped Strategy retry and fresh v1 confirm-pair remain
unavailable. Historical v1 recovery requires the original verified receipts,
current native application access and no selected-v2 intake companion; it
cannot create consent or work. A selected v2 approval must be recovered through
its exact v2 wrapper. Existing cancellation and authorized reads remain available.

## Qualification boundary and remaining dependencies

Focused tests use actual source modules, including the private shared codec;
the Node data-URL loaders record exact source hashes and declared rewrites.
The isolated PostgreSQL suite exercises actual restricted-role intake,
rollback, replay, RLS, worker exclusion, deadline and global-writer contention.
Its request identity seam is explicitly test-only; native membership, client,
source and policy reads remain real. Default-off import constructs no database
client or private target. Qualification results belong to the exact reviewed
source pin and accompanying PR evidence.

Reproducible source checks from the repository root, with existing dependencies:

```powershell
node apps/api/node_modules/jest/bin/jest.js --config docs/objective-strategy-core-20261017/qualification/intake.jest.cjs --runInBand
node apps/api/node_modules/typescript/bin/tsc -p docs/objective-strategy-core-20261017/qualification/intake.tsconfig.json --noEmit
node --test apps/api/src/auth/workload-authority/objective-workload-current.focused.test.mjs apps/api/src/auth/workload-authority/objective-workload-jwt.focused.test.mjs apps/api/src/auth/workload-authority/objective-workload-later-current.focused.test.mjs apps/api/src/auth/workload-authority/objective-workload-proof.focused.test.mjs apps/api/src/auth/workload-authority/objective-workload-retained-signed.focused.test.mjs
git diff --check
```

At source freeze, the combined ten Jest suites passed 200/200, strict TypeScript
passed without diagnostics, the five workload Node suites passed 94/94, and the
twelve affected Strategy/Planner Node harnesses passed 548/548 with zero skips.
Node version was 22.23.3. The new native cases are intentionally skipped without
the separately reviewed exact-target opt-in; a default-off pass is not a native
database qualification. No dependencies were installed for these checks.

Positive production admission/promotion is unqualified. All five Strategy
workload authority methods remain unavailable, the historical delegation
`enabled=false` migration fence remains intact, and PR57's admission ingress
was unmounted at that source freeze. The additive successor described in
[Core/Meri composition and decision](CORE-MERI-COMPOSITION-DECISION.md) registers
the actual admission route with a hard-disabled production runtime provider.
It composes the existing production factories for explicit trusted bindings;
no positive grant, raw-body bootstrap allocation or activation is supplied.

The resumed Meri owner confirmed that genuine production prepared facts omit
Objective fields, immutable accepted-request-to-full-run binding custody is not
composed, signed accepted-source/retained readers are not mounted, and existing
Meri EdDSA/Ed25519 versus historical Core RS256 protocols need joint allocation.
The proposed trusted accepted-source read must resolve independently from
Meri-owned immutable custody; Core publication and caller binding are only
comparators. Never serialize secret-bearing `resolveFacts()` output. Until
those real source and matching issuer/verifier contracts are reviewed, reserved
jobs stay closed and browser-independent execution cannot be claimed.

Frontend PR75 remains GET-only and default off. A separate reviewed consumer
must adopt this exact v2 contract before any Strategy action is exposed. This
slice does not modify Meri, shared auth/session files or first-chat shipping pins.
