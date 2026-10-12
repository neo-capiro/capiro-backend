# Independent review of the canonical grant writer

**Accept the bounded source change** at `926b269ad6e3b5ed789b5d18f55306df310d046c`, tree `20f6c336489913c6f4c16a98f2a16fed4847ecd4`. No remaining concrete source blocker was found. A fresh replay of the author's exact spec passed **16/16**, and independently authored method/authorization controls passed **41/41**. Native database qualification remains separate.

Only `apps/api/src/clients/clients.service.ts` and its new lock-order spec differ from published PR2429 `277053c8196dc1be4789c42ea304b0de0553fe00`. All **23,161 prior Git paths outside those two paths retain their exact blobs and modes**. The whole service is byte-exact to its original after removal of one unique nine-line insertion. The reviewer did not edit application source.

## Authorization and scope

The existing canonical PUT entrypoint remains `ClientsController.setMemoryAccess`, `apps/api/src/clients/clients.controller.ts:398`. It has `@Roles('user_admin')`, class-level `@UseGuards(RolesGuard)`, a server-owned `@CurrentTenant()` argument and the same boolean/UUID-array DTO. This is a **minimum user_admin rank**, so the existing capiro_admin rank is also allowed. Independent execution of the unchanged RolesGuard method permits these two ranks and refuses standard user, client portal user, unknown role, absent tenant context and an unknown required route role.

Tenant middleware still applies to the clients route (`apps/api/src/app.module.ts:150`); verified-token and active-membership context construction remains in the unchanged middleware. The reviewer inspected these published owner boundaries without invoking authentication, provisioning or a provider. The fragment tests do not authenticate an HTTP request or create a current membership; they consume fake established context. There is no new service-level authorization policy in this fix.

The new tagged-template lock at `apps/api/src/clients/clients.service.ts:1608` binds **ctx.tenantId and clientId as two separate values**, with explicit UUID casts and both tenant/client predicates. This matters because raw SQL is not protected by the existing scoped ORM query hook. The first operation inside the existing withTenant callback is the awaited lock; withTenant's unchanged transaction-local context setup still precedes the callback (`apps/api/src/prisma/prisma.service.ts:157`). No bypass, role, permission, transaction, retry or timeout rule was added.

## Ordering and preserved behavior

The canonical reader owners acquire client protection before grant protection: `packages/shared/src/client-objective-destination.ts:76` then `:84`, and `packages/shared/src/workspace-saved-revision.ts:141` then `:149`. The writer now acquires an exclusive tenant/client row lock before reading the client, membership or roster and before grant replacement. This removes the writer's grant-before-client ordering for the scoped reader/writer cycle and gives same-client complete-roster writers a common serialization point. Different clients bind different row keys.

An absent lock row throws the existing `Client not found` NotFoundException before any subsequent owner operation. The original ORM findFirst/404 remains. Membership rejection, ordered deduplication, grant create/delete arguments, memoryWall update, actor/tenant audit, sorted before/after snapshots and returned grant order are byte-exact to the original. Thirteen independently executed original/candidate scenarios have identical non-lock traces, result/error data and inputs. Lock failure identity is propagated and later owner errors still stop subsequent operations. Source insertion occurs even for unchanged flags/rosters, so writers share the same gate in those cases too.

## Meaningful inert controls

The author spec is useful: it extracts the unique actual MethodDeclaration and exercises its awaited transaction sequence, empty result, lock errors, membership boundary, full replace-set arguments and audit. It avoids importing or constructing the real service, Prisma client or S3 dependencies. The independent replay used a byte-exact test copy and a service-source symlink in a private-only Jest root with no setup files, provider/native module refusal, protected reporting-read refusal and standard network/process refusals.

Independent controls add nine syntactically valid in-memory source adversaries: omitted tenant predicate, omitted client predicate, substituted tenant value, substituted client value, SHARE replacing UPDATE, wrong table, absent await, missing empty-row 404 and a lock moved after the first owner read. All are refused by the actual fragment contract probes. The original source is also refused by the new lock contract. A deterministic synthetic exclusive-lock owner demonstrates that the actual awaited method blocks a second same-client writer before owner reads and permits a separate-client writer. These prove source sequencing and call binding under the specified fake lock semantics; they do not prove PostgreSQL locking or database rollback.

Frozen author evidence at `4c4791ea1e66032fa435b889562c02a3e43eb027` contains only docs after the source freeze. Its **50 packet file hashes and two source bindings** were verified independently. The author additionally retains the original 1-pass/15-fail new-contract baseline, six actual-spec mutation refusals and eighteen non-lock differential scenarios. Those are source-contract results, not fifteen pre-existing default-suite regressions.

The review's first late-lock adversary probe released a fake promise before its deferred lock existed. Its partial output and script remain intact. The corrected bounded-microtask probe passes all 41 controls. The initial stop matcher missed literal `node` argv[0]; its correction stopped only that exact own inert process. An exploratory source-proof Python keyword error and two absent read-path guesses are also recorded. No application fix was made in response to these harness issues.

## Acceptance limits

The raw FOR UPDATE requires the existing application role's SELECT/UPDATE authority on clients, including roster-only requests; this review makes no permission expansion. Actual grants/RLS behavior, blocked reader/writer interleavings, rollback, Prisma runtime and target fixture completeness need the separately approved native runner. The source change targets this client/grant ordering and does not establish global freedom from deadlocks involving unrelated writers.

A new raw-lock failure is intentionally propagated rather than translated. Valid-UUID owner behavior and unchanged later errors are covered here; malformed UUID SQL/Prisma diagnostics and HTTP exception envelopes were not natively qualified by these fragments. Current API authentication and full application compilation remain owner/integration qualifications, not claims from the isolated tests.

No database connection, SQL/migration execution, native engine download/generation, real provider call, permission or credential operation, deployment or main merge ran in this review. No protected reporting body or denied detailed retirement report was read or copied. Prior audit head `bbc1bb5fad625970bd2d54d974b2a8cb7ca1f1ff` and all earlier branches remain preserved.
