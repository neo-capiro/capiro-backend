# Independent review — native model-only tenant configuration

## Verdict: QUALIFIED PASS

No release-blocking defect was found in the reviewed snapshot for the requested narrow behavior. The existing controller-level `capiro_admin` guard remains in place, and the additive path further constrains caller context, requested target, and persisted tenant identity to UUID `17b63099-bc0f-4ac5-b596-496161e9481e` / slug `capiro-internal`. The store path is limited to the active OpenAI credential and the single allowed model value or a null restore.

This is a source review, not a test or deployment sign-off. The reported earlier 43-test pass is treated as supplied context only; I did not run tests, typecheck, cloud commands, or other execution. Final tests/typecheck were reported as running and are therefore NOT VERIFIED here.

## Findings

### No blocker found in inspected source

- **Guard and scope:** `CapiroAdminController` retains class-level `@UseGuards(RolesGuard)` and `@Roles('capiro_admin')`. The service independently requires both the caller context tenant ID and requested target ID to equal the fixed internal UUID, requires the context slug to match, then looks up the persisted tenant and checks its ID and slug before delegating. A different target, actor context, or stored slug is rejected before credential mutation.
- **Runtime input validation:** The route rejects extra body keys, requires provider `openai`, accepts only `gpt-6.1-sol` or the explicit `restoreDefault: true` path, requires an explicitly supplied expected override (string or null) and canonical UTC timestamp, and rejects malformed dates including rollover dates. The service and store repeat the critical mutation-value/CAS checks rather than relying only on DTO decorators. `restoreDefault` maps to an actual `null` override.
- **CAS and mutation boundary:** The store reads only a safe selected field set (provider, last-four mask, override, status, validation time, update time), rejects absent/inactive credentials and stale override or timestamp values, then uses a conditional `updateMany` predicate containing tenant, provider, active status, expected override, and expected `updatedAt`. A count other than one is a conflict. This guards both the preliminary-read race and stale client updates.
- **Key preservation and cost path:** The mutation data contains only `modelOverride`; the operation does not select ciphertext/IV/auth-tag or call the resolver's provider validation path. Readback is masked and retains last-four/status/metadata shape. No API key is accepted by this route. The reviewed path adds no provider-validation request or billing/generation call. The existing normal credential upsert is a separate path and is not used by this method.
- **Readback / false-success handling:** After the conditional write, the store reads the safe fields again and refuses to return success if the row is missing or no longer active. The transaction callback is run through `withTenant`; exceptions from the CAS or readback checks escape that callback and cause the interactive transaction to roll back. The controller test exercises successful delegation and the Sol-to-null restore mapping; service/store specs cover scope rejection, missing/inactive and stale/CAS-miss cases, masked output, preservation of non-model fields, no validation on model-only updates, and no success audit after a rejected mutation.
- **Audit behavior:** The service writes the model-override audit only after `updateModelOverride` resolves successfully; the audit payload contains override/timestamp and masked configuration details, not key material. Failure before a successful store return produces no success audit. No schema or global-default changes were present in the inspected source set.

## Qualified limitations / follow-up

1. **Mutation and audit are separate transactions.** The credential store transaction commits before `writeAudit` starts its own `withTenant` transaction. Therefore an audit-write failure can leave the model change committed while the request fails and no audit row exists. This is not a false success and does satisfy “audit only successful mutation,” but it is not atomic success-plus-audit. Decide whether that existing failure mode is acceptable for this scoped benchmark; if audit completeness is required, the mutation and audit need a shared transaction boundary.
2. **Tenant slug check has a narrow TOCTOU window.** The database ID/slug verification uses `withSystem`, then the credential update runs later in `withTenant`. A concurrent slug change between those operations could invalidate the slug condition after it was checked. The fixed UUID still prevents another tenant from being targeted. If the slug must be guaranteed at mutation time rather than verified immediately beforehand, the slug condition would need to be made atomic with the mutation. This is not shown to be exploitable under the current operational assumption that the internal tenant slug is stable.
3. **Transaction tests are mocks, not database integration evidence.** The source uses the real `withTenant` interactive transaction contract and throws on CAS/readback failure, but the inspected unit mocks cannot establish PostgreSQL/Prisma rollback behavior, actual `@updatedAt` handling, or concurrent database behavior. The conditional update predicate is explicit; these runtime semantics remain for the running test/typecheck (and any integration coverage) to confirm.
4. **Scope of review:** I reviewed the supplied `evidence/` snapshot and its controller/service/store/resolver/Prisma code and tests. I did not inspect a live database, deployed configuration, cloud state, or the still-running final checks. No execution result or deployment readiness is claimed.

## Reviewed source locations

- `evidence/apps/api/src/capiro-admin/capiro-admin.controller.ts`
- `evidence/apps/api/src/capiro-admin/capiro-admin.service.ts`
- `evidence/apps/api/src/capiro-admin/capiro-admin.service.spec.ts`
- `evidence/apps/api/src/ai-usage/ai-credential-store.service.ts`
- `evidence/apps/api/src/ai-usage/ai-credential-store.service.spec.ts`
- `evidence/apps/api/src/ai-credentials/ai-credential-resolver.service.ts`
- `evidence/apps/api/src/prisma/prisma.service.ts`
- `evidence/apps/api/src/auth/roles.guard.ts`

No source files were edited.

## Status

- Source review: **QUALIFIED PASS**
- Blocking findings: **None found in inspected source**
- Runtime tests/typecheck: **NOT RUN by reviewer; reported running**
- Cloud/deployment verification: **NOT RUN**
- Changes made: **REVIEW.md only**

Overall, this is suitable for the stated narrow benchmark scope subject to the audit-atomicity and runtime-verification limitations above.