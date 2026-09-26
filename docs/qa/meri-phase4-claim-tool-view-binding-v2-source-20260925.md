# Dormant Phase 4 claim/tool-view binding V2 qualification note — 2026-09-25

This package remains dormant and unregistered. It does not register a Nest provider, replace the active Hermes adapter, enable the worker overlay, provision a production producer, create a production credential, change live ingress, run a production migration, or deploy anything.

## Boundary added

- A source-qualified binding V2 pins the worker image digest, build ID, raw worker-catalog digest and algorithm, Meri catalog version and digest, capability-mapping version and digest, request-local tool-view protocol, claim-attestation protocol, and the purpose-separated attestation credential identifier.
- Existing V1 bindings remain immutable tombstones but are ineligible for V2 predispatch and claim. `capiro_app` lost the V1 binding-lock grant and receives only the V2 lock.
- The V2 authority migration is atomic and capability-gated: its administrative executor must be able to self-grant the existing NOLOGIN authority owner and temporarily grant that owner schema CREATE. Both privileges are revoked and verified absent before commit. It does not require the `rolsuper` label, but managed-database compatibility remains a deployment rehearsal gate.
- Source-specific producers receive no grant from the migration. A reviewed qualification operation must later grant only the V2 attestation and existing revocation functions to one independently authenticated producer LOGIN.
- Predispatch locks one complete V2 binding after taking the exclusive tenant authority fence. Claim locks the same binding and requires exact image/build/catalog/mapping/protocol/credential equality.
- The claim token format has no caller-selected key ID. The locally resolved route binding selects one purpose-separated attestation key, and the mint helper recomputes the observed raw catalog plus final provider-visible schemas before signing. This slice does not yet implement the worker-side mint/transport protocol.
- TypeScript and the Python overlay share versioned catalog/tool-view digest algorithms and one golden vector. Full provider function schemas are canonicalized; ambiguous names, floats, unsafe integers, invalid Unicode, oversized input, omitted required tools, and provider-side schema widening fail closed.
- The route-bound resolver accepts only an exact HTTPS origin and an exact source-qualified V2 binding. It has no static/default fallback and is not wired into the active adapter.
- `MERI_HERMES_TOOL_VIEW_SIGNING_KEY` is distinct from `API_SERVER_KEY`. The extension remains disabled unless `MERI_HERMES_TOOL_VIEW_V1_ENABLED=1` is deliberately supplied.

## Executed qualification evidence

- Focused hermetic TypeScript: **10 suites, 131 tests passed**. This includes one-field binding drift matrices, terminal-surrogate/oversize/depth rejection, claim window/shape tamper cases, and mutation across the capability-negotiation await.
- Strict targeted TypeScript compilation passed using `tsconfig.meri-phase4-claim-attestation.json`; that config and the image/database rehearsal scripts are wired into the API `typecheck` command. The repository-wide first typecheck stage is not recorded as passed in this checkout because unrelated workspace package declarations such as `@capiro/meriv2-core` and `@capiro/defense-domain` were unavailable.
- Worker contract: **15 tests ran, 14 passed, 1 skipped**; Python bytecode compilation passed. The skipped pinned-upstream archive test had no `MERI_HERMES_PINNED_ARCHIVE` and no v2026.9.14 archive under the workspace, so this is not archive-compatibility evidence.
- Prisma schema validation and client generation passed.
- `pnpm --filter @capiro/api verify:meri-phase4-binding-v2:db` provisioned fresh PostgreSQL 16 + pgvector, exercised all **438 migrations**, verified the expected first-run PUBLIC hard-gate failure, applied only the reviewed disposable PUBLIC baseline while retaining the two required pgcrypto APIs, reran the migrations, asserted zero surviving owner membership/schema-CREATE and zero PUBLIC EXECUTE on non-extension routines, ran the database tests, and removed its owned container.
- Real PostgreSQL: **2 suites, 6 tests passed**. The V2 suite rejects partial-NULL rows, malformed/expired inputs, replay drift, wrong source/session role, and accidental role grants; it verifies the full 15-field V2 lock projection, legacy denial, one-way revocation, source-specific LOGIN authentication, and exact replay. The route/session suite again proved that impersonation End cannot return before the in-flight route mutation commits.
- With the disposable opt-in variables absent, the V2 database suite was also collected safely as **5 skipped tests** rather than opening a database or failing module evaluation.

## Remaining activation gates

This local evidence does not authorize activation or deployment. Activation still requires worker-side claim-attestation minting and transport plus a cross-language HMAC vector; the pinned v2026.9.14 archive or exact production image for overlay qualification; independently reviewed production source qualification and key custody; an approved production PUBLIC privilege inventory/baseline and rollback; proof that the production migration executor satisfies the V2 owner/schema capability gate; production image/build/catalog/mapping values; trusted ingress-to-route resolution; worker termination and lost-response receipts; reconciliation and operational runbooks; the plan's independent Phase 5 adjudication and representative signed live cohort; and the user's explicit deployment GO.

Until those gates close, no active transport may consume this resolver or claim-attestation package.
