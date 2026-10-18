# Core Objective admission source qualification

Parent: qualified PR56 `bdcb546804f35d0973603fca5e99dbd4d640953f`,
tree `fb63bf272b032508f51d166dba48c8497ad51255`.
Branch: `feat/objective-core-admission-20261017`.
This is a source increment and technical contract; it does not mount or
activate an issuer, receiver or Strategy execution path.

## Implemented behavior

`objective-workload-admission-ingress.ts` composes the existing named caller
proof verifier and durable issuance adapter. It defaults disabled before any
clock, source, signer or transaction access. The dedicated future transport
must supply the actual method/original URL, exactly one Authorization header
and the captured HTTP entity bytes. This factory does not capture HTTP bytes
or validate duplicate raw headers on behalf of an unimplemented transport.

The only admitted wire body is the following UTF-8 encoding, in this exact
key order, without whitespace, BOM, duplicate keys, aliases or extra fields:

```json
{"schemaVersion":1,"operationId":"UUID","generationJobId":"UUID","phase":"admit"}
```

Both UUIDs must have the existing canonical lowercase wire syntax. The actual
method is `POST`; the actual original URL is exactly
`/api/internal/objective-workload-authority/decisions`, without a query.
The body limit is 4096 bytes. The caller proof uses the existing pinned-key
RS256 protocol, a maximum 30-second lifetime and the fixed generation-worker
subject. A trusted terminal or result-reader pin cannot request admission.
Buffers and scalar data are captured before the first asynchronous lookup;
accessors, proxies, foreign byte views and shadowed byte-view properties deny.

`objective-workload-admission-source.ts` derives scope from one real joined
Strategy job and its native delegation. It accepts no caller tenant,
delegation, consent, audience, target URL, body, attempt or run. Its bounded
system transaction also checks any existing global operation decision for
the original caller/raw-request/tenant/job/phase tuple. It then records only
the native tenant, fixed service role/action and actual job identity in
`audit_logs`, in the same transaction. This is audited routing, not a grant.
Unknown or ambiguous scope and failed auditing return no source. No invented
audit tenant or globally durable unknown-scope denial is claimed.

The downstream target is fixed:
`POST /strategy-api/internal/objective-canonical/generation-admissions`,
with Core-derived bytes `{"schemaVersion":1,"generationJobId":"UUID"}`.
The incoming request hash and downstream target-body hash remain distinct.

The original durable issuer independently rereads the exact native source
under its original locks and database clock. It commits its permanent
decision, proof use, authorization JTI and delivery claim before signing,
then rechecks authority before finalizing delivery. Existing denied decisions
remain denied, and a committed lost claim remains uncertain. The routing
snapshot is not a concurrent uniqueness guarantee: the original operation
gate, global decision key and atomic claim remain the final race fences.

Three immutable SQL reads now use SELECT without `FOR SHARE`, matching the
existing migration's revoked UPDATE privileges. Tenant/key predicates and
immutable semantics are preserved. Mutable delivery row locking and its
claimed-state compare-and-set remain unchanged. No privilege grant changed.

## Reproducible focused checks

Run from the repository root with its existing dependencies:

```powershell
node apps/api/node_modules/jest/bin/jest.js --config docs/objective-strategy-core-20261017/qualification/jest.cjs --runInBand
node apps/api/node_modules/typescript/bin/tsc -p docs/objective-strategy-core-20261017/qualification/tsconfig.json --noEmit
node --test apps/api/src/auth/workload-authority/objective-workload-jwt.focused.test.mjs apps/api/src/auth/workload-authority/objective-workload-proof.focused.test.mjs
git diff --check
```

Observed on Node `v22.23.3`, using borrowed existing dependencies without an
installation:

- Four Jest suites: **89/89 passed**. This includes 51 new admission source
  and composition cases, 16 SQL-port cases and 22 existing durable issuer
  cases. The 16 SQL-port cases include 12 new immutable-read regressions.
- Scoped strict TypeScript: passed, exit 0.
- Existing JWT/caller-proof vectors: **12/12 passed**.
- Whitespace/error check: passed.

The focused Jest configuration has no API-wide setup files or database
provisioning. Real RSA proofs, the real source resolver, the real durable
issuer and the real final JWT verifier run against explicitly synthetic
transactions/current facts. The tests cover exact replay, cross-scope
rerouting, unknown scope, default-off behavior, input mutation, canonical
bytes, auditing failure, source revocation, persistent denial, uncertain
delivery and the actual Prisma current loader's disabled gate. They do not
execute SQL or prove native grants, RLS, concurrency or positive issuance.

An additional direct invocation of the unchanged
`objective-workload-current.focused.test.mjs` stopped before assertions:
its data-URL import of the Strategy wrapper cannot resolve
`@capiro/shared/objective-planner-owner-codec` after the existing shared
codec extraction. This baseline harness limitation is not counted as a
passing current-facts vector run. Its source and the current-facts loader
are unchanged here; no native-current qualification is claimed.

## Remaining runtime and source boundaries

The delegation migration still enforces `CHECK(enabled=false)`; no enabled
delegation, credential, signer/trust provisioning or migration is created.
The factory is unmounted. No application module, HTTP bootstrap, Clerk or
tenant/session middleware, shipping recipe, first-chat pin, public work
envelope or Meri source is changed.

Strategy remains unavailable in the mounted Work owner. Its immutable
selected type, atomic canonical intake, native reconciliation/policy,
receiver verification, later-phase native source and independent original
Meri issuance/accepted-run/custody bindings are still required. The held
source interface is in [SELECTED-TYPE-ATOMIC-INTAKE-INTERFACE.md](./SELECTED-TYPE-ATOMIC-INTAKE-INTERFACE.md).
No new public Strategy or task discovery route is introduced; PR53/PR56 and
frontend PR69 contracts are preserved. No native PostgreSQL procedure,
product HTTP execution, model work, build, deployment or live AWS change was
run for this source increment. The SQL resolver and audit are exercised
through test doubles only. GitHub source publication and non-secret owner
coordination are separate from product execution.

Independent source review is recorded with the published draft PR. Historical
Planner qualification remains attached to its original exact source pins;
it does not qualify positive issuance for this increment.
