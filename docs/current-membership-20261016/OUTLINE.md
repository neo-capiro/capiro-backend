# Current membership source increment

Base `016e79b585c14f20d13669e13c987c01e3dd29dd`; isolated branch `feat/core-current-membership`. Frozen backend, manual-plan PR27 and inactive PR28 remain untouched.

Startup owner accepted `POST /api/clio/application-authority/membership {}` as a sibling to the existing identity endpoint, using the same request-local production Clerk/current-identity owner. The receipt is closed: tenantId, actorId, active status, actual selected-tenant canonical role, permissions=[], sorted unique permitted client UUIDs, membershipRevision, checkedAtMs and original finite expiresAtMs. The empty permission set adds no business grants. Existing identity/context receipts remain unchanged. Startup owns native bearer propagation through its existing membership port and every recheck; no static cross-user credential or token cache is introduced here.

Canonical responsibilities:

- Existing TenantContextMiddleware and ClerkService own verified native identity/current session, exact user/tenant/membership/impersonation provenance and original expiry. The new endpoint does not verify JWTs or mint claims itself.
- Existing active-member Clerk-actor wall helper owns client enumeration. Add only an optional server-owned row bound; default callers retain their existing complete roster semantics. No second wall predicate or administrator bypass.
- New cohesive membership types/service/controller compose actual selected-tenant membership and repeated current source reads. Missing, inactive, foreign or below-floor membership denies, including an impersonated target with no actual membership. Changed observed facts conflict. Receipts are point-in-time observations, never locks, leases or grants.
- New revision hashes membership ID/status/role/update and sorted permitted client ID/revision facts; it does not turn clocks, token expiry or empty roster into rights. Client source revisions do not attest invisible historical changes between observations.
- Controller owns a bounded request lifetime (at most30s, caller deadline may shorten), disconnect checks and no-store response. It does not claim that abort cancels or rolls back already-started database/provider work.

Owned source: auth/application-membership*.ts, narrow registration in auth/application-authority.module.ts, optional bounded parameter in memory/memory-wall.helpers.ts. Existing module tests are extended; new isolated actual-source tests cover denied/revoked/foreign/client/changed/expiry conditions. No schema, credential, environment, provider, database migration, legacy Meri loop or shared-contract edit.

Focused security tests are run after the coherent source batch. Broad typing/build/browser/native qualification remains at the integration checkpoint. Local tests substitute DB and Clerk I/O and cannot prove live access or deployment. If the native bearer/endpoint binding is absent, startup remains unavailable; no new workload credential is fabricated.
