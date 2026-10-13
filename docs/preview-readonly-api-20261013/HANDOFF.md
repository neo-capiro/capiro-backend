# Preview-only API read path

This separate bootstrap admits exactly GET `/api/me`, GET `/api/clients`, and GET `/api/clients/:uuid` for an existing active `capiro-internal` member. It does not change the production bootstrap or tenant middleware. Internal ordinary members remain `standard_user`; only the canonical exact Clerk admin keys paired with a matching local membership produce `capiro_admin`. Both roles remain bounded to the configured internal tenant in this process.

Base: private backend import `c76f5fc0df6688743afeec274211afd2e67fe8f1`, tree `3bae0d1a303662260673ecb0c5ac0a8bfe551829`. The receiving PR #1 (`6efe59f24b4a711b7991bae4b2a255c667cbbf00`, tree `5e1812b853811f793b30fe7de0e956f65c28f056`) is independently published and is not a dependency. The frozen import has the minimum qualified application source; reviewed cleanup donors do not delay preview qualification. No main merge or deployment is authorized by this packet.

The preview module registers one controller with three read handlers. It invokes the unchanged canonical UsersController `/me` implementation as a provider, and shares the extracted canonical client query helpers with ClientsService. Production client reads retain their existing signed logo projection. Preview logo URLs are null: no S3 credentials, signing, uploads, or provider modules are introduced. This is an explicit reduced preview representation.

Authorization resolves only the exact verified Clerk `sub`, an existing membership for the pinned tenant, and the active tenant's pinned Clerk org and reserved slug. No email lookup, identity adoption, provisioning, membership self-heal, lastSeen update, denial audit, impersonation, or broader role exists on this path. Conflicting tenant/role claims fail closed. Signed actor claims, online session actors and impersonation headers are refused. The existing canonical read-only Clerk active-session check runs before and after the handler; no real provider call was executed in qualification.

The canonical Prisma owner opens one scoped PostgreSQL ReadCommitted transaction with `SET TRANSACTION READ ONLY` as its first statement. It refuses a superuser, BYPASSRLS, role/database-creating, table-owning or effectively DML-capable runtime identity, and requires `default_transaction_read_only=on`. It explicitly clears `app.bypass_rls`, sets the pinned tenant GUC, and reuses the same transaction for canonical `withTenant` reads. A different tenant, `withSystem`, and `withTenantUser` escape are refused. Preview startup verifies that boundary with an empty read-only transaction before listening. Unexpected errors become generic 503; startup exceptions are not echoed with connection inputs.

The response remains buffered until a second current identity/membership/tenant read and transaction commit complete. Membership revision changes or a revoked session before those checks cause refusal. The final ReadCommitted authority query is the local authorization linearization point: revocation after that statement, or Clerk org changes not yet mirrored locally, cannot be made atomic with HTTP delivery. This packet makes no stronger guarantee. The second Clerk lookup can consume the five-second transaction budget and fail closed. There is no cached local authorization or durable bearer receipt.

## Integration and overlap matrix

| Slice / owner | Dependency or overlap | Admission |
| --- | --- | --- |
| frozen private `backend-import` c76 | exact source base; all original candidates preserved | required |
| receiving PR #1 6efe | sibling branch; cleanup and classifier evidence | not required |
| this preview branch | PrismaService method additions; ClientsService read extraction; separate bootstrap | source review only |
| production AppModule/main/TenantContextMiddleware/ClerkService | no body changes | production behavior unchanged |
| protected scoped EngagementService owner | no body/branch changes or claims about unpublished work | independent |
| frontend preview PR #23 e166 | current business allowlist remains empty | add only the exact three GET patterns after separately reviewed runtime/native acceptance |
| deployment/image proposal | existing fixed-source image guard does not admit this new head automatically | new image/head review required |
| AWS, credentials, role grants, native PostgreSQL | none executed or changed | held |

Frontend must forward the reviewed bearer and internal tenant hint, retain read-only presentation and default deny for every other route/method, and handle missing/mismatched identity as unavailable. This API has no health route in its initial exact allowlist; use a separately reviewed liveness mechanism rather than widening this contract. Clerk production reference metadata is in the authoritative receiving CURRENT-OWNER-DECISION packet. There is no staging environment. Do not pursue historical staging references or create a second Clerk app implicitly.

Run the compiled isolated entrypoint `node apps/api/dist/src/preview-readonly/preview-main.js` only after runtime approval and native qualification. The ordinary `serve` entrypoint does not select this module. This packet contains source instructions, not a performed launch.

## Qualification

Four selected suites pass, 136 cases total: new bounded preview authority/HTTP regressions, existing `/me` projection, exact Clerk-role mapping and Prisma conflict utility regressions. Synthetic Nest HTTP tests cover all three GETs, wrong-tenant detail, absent/mismatched identity, missing/inactive membership, wrong org/tenant/issuer/role, admin/member distinction, actors and impersonation, replay/revocation, membership revisions, expiry, commit refusal, transaction scope/ALS isolation, and blocked methods/routes/overrides before dispatch. The test database has no write delegates; any identity/business/audit write would fail. Provider methods are synthetic and outbound networking is fenced; loopback is permitted for the synthetic HTTP server only.

The full canonical Shared build passed. Full API production type roots plus the selected/new specs are checked with the actual tsconfig; unselected global specs are not qualified. Final result is recorded in evidence/RESULTS.json. Every failed launcher, type and Jest run remains in the finite evidence packet. Raw warning whitespace is preserved in lossless base64 envelopes where required by source hygiene.

No native Prisma engine, Postgres/RLS acceptance, production identity/session, real data/provider call, image build, permission change, migration, AWS operation, merge or deployment occurred. Docker availability does not qualify native database acceptance. Native downloads remain blocked; no bypass or checksum disabling was used.
