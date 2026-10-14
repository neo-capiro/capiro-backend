# Core preview using the existing database

The user explicitly permits preview use and writes to the existing database, including ordinary account metadata. An isolated database, another Clerk application, additional tenant protection, or a read-only ingress is not a prerequisite. Existing Clerk, membership, tenant/client walls and command permissions remain unchanged. This source proposal does not authorize a destructive migration, new persistent access, unrestricted background actions or deployment.

## Concrete source

Base is PR22 `2875afa0cf65053b5faa2b29e742c81cba446931`. The source-only branch is `fix/preview-core-existing-database`. The Core image/native diagnostic stays with shipping; these infrastructure changes do not alter its Docker recipe, app source, schema, SQL, migration names/checksums or lockfile.

`infra/cdk/lib/preview/existing-core-application.ts:existingCorePreviewApplication` is the opt-in composition. It validates closed reference-only metadata before constructing a CDK App, then defines only a new task definition, zero-count service, target group and host/path rule. Existing database, cluster/VPC/private subnets/security group, task/execution roles, log group, asset bucket and Clerk references are borrowed. No database, IAM role/policy/grant, secret, network rule, certificate, DNS record or production-service update is synthesized. The synthetic fixture is not deployment input.

The proposed workload is `capiro-preview-core-existing-db` in existing `capiro-dev`, private networking, ARM64, ordinary `serve`, port4000 and `/health`. It mounts the existing Clerk secret AND webhook-signing reference; it retains issuer `https://clerk.app.capiro.ai`. The proposed distinct hostname is `core-preview.app.capiro.ai`; it is not asserted to exist or to be approved. A host-scoped rule priority1–4 must precede the shared generic `/api/*` rule10. Its only paths are `/api/*` and `/health`; existing production webhook routes are not redirected. Frontend `CORE_API_BASE_URL` would become `https://core-preview.app.capiro.ai/api` only after shipping admission. Strategy/Workspace origins and Meri configuration stay separately owned and unchanged.

The older optional isolated three-service proposal is preserved, with Core corrected to ARM64 and `/health`, required webhook reference added to its closed bindings, and the same Core runtime controls. It is not the mandatory route and must not be applied incidentally.

## Canonical startup controls

`core-runtime-environment.ts` composes existing switches: API identity; Engagement shadow/background disabled/external actions disabled/callbacks and Recall disabled; auto-sync and SAM enrichment disabled; notetaker, profile-fill workflow/completion, research-watch delivery, newsletter review/invitation email and Meri sweeper disabled; Outreach V3 reasoning/generation/full-generation/send disabled. No new authorization or worker policy exists. Normal account/client/task metadata writes through approved existing handlers are not changed to read-only.

Owners: `apps/api/src/engagement/runtime/engagement-runtime-{env,policy.service}.ts`, `engagement-sync-scheduler.service.ts`, client profile-fill workflow/completion owners, `research-portfolio-watch-worker.service.ts`, the two newsletter workers and `meri-job-lease-sweeper.ts`. The actual canonical environment resolver and completion runtime are exercised by focused tests. Directory startup can still prewarm its existing read cache. These checks are not a full `.init()`/native isolation proof or authorization for unreviewed provider/upload/send flows; inspect the real service's startup and admitted operations before count1.

## Read-only observations and migration meaning

Observed preview frontend revision7 has ordinary mode and upstreams `https://os.capiro.ai/{api,strategy-api,workspace-api}`; only that frontend exists in the preview cluster. Existing shared Core650 runs2 ARM64 tasks. Shared service names contain dev but route through the production ALB. Adding this separately named workload does not replace Core650 or any existing service.

The already-completed read-only ledger capture at2026-10-14T15:29:29Z is `/capiro/dev/api`, stream `ledger-observed-ae5bbc85/api/5d0758e8e58f4f05875fa4ecf50817f3`. It observed `capiro.public._prisma_migrations`:646 attempts,545 finished active,0 unfinished, frontier20281008040000_federal_evidence_passage_search. Four Core newsletter paths and ten Workspace newsletter paths have finished records with exact source checksums. Eight Core and three Workspace additions have no matching record. The capture explicitly says live-service applicability UNKNOWN and absentRecordMeaning UNKNOWN_NOT_NEVER_APPLIED. Neither missing names nor suffix resemblance establishes unapplied/equivalent SQL. Retrieve the full retained source catalog and history before proposing effects.

Preserve all historical names/checksums. In particular, the four dated Core newsletter paths already have exact finished records despite failing the source timestamp rule. Do not rename them. Layout's source timestamp defect is a separate allocation question; no rename/resolve/reset is implemented. Schema-effect checks must cover actual definitions, constraints/indexes, enums, functions/triggers, RLS/grants and backfill postconditions, plus alternate histories and old/new writer compatibility. The proposed service runs serve, never migrate or seed.

## Exact decisions before deployment

Already approved: existing database reuse and ordinary authorized preview/account metadata writes. Do not ask again for an isolated database, new auth app or generic tenant permission.

1. Accept the returned exact source and shipping's immutable Core image/source/platform/scan/native startup tuple. A source hash or synthetic template does not qualify an image.
2. Approve the four-resource held stack and use of the confirmed existing Core task/execution roles, private subnets/security group, database/Clerk references, existing log group and asset bucket by the newly named service. Verify existing access is sufficient; no IAM/SG change is included. Any missing permission is a separate exact proposal, not an implicit broad grant.
3. Approve the specific new hostname/DNS/TLS binding and free host-rule priority on the existing shared ALB. Verify certificate coverage; DNS/certificate work is not included in this source stack. The old `/api/*` production rule and existing service stay unchanged.
4. After schema-effect verification, propose ONLY demonstrated missing effects against the existing database, with exact SQL/checksum, locks/backfills/grants, preservation and rollback compatibility. Any migration-history repair or destructive action remains separately authorized; ordinary data-write approval does not authorize it. Fourteen exact finished matches are not rerun merely to satisfy a new source timestamp.
5. Approve activation of this service from0to1 and the preview-only Core upstream switch, after real health/Clerk/current membership/ordinary owned-data flow checks. The source leaves count0. Initial examples should be finite, current-authorized account/client/Objectives/layout flows; provider sends, paid calls, storage mutations and background activation require their concrete approved operation scope.

Rollback is the preview upstream change plus retirement of this new service; it does not revert data written through the shared database. Schema/data backward compatibility remains required if migrations are separately approved. There is no new whole-project staging or production cutover claim.

## Verification boundary

Exact locked verification dependencies are installed in a task-owned directory: CDK2.271.0, constructs10.8.1, TypeScript5.9.3, ts-node10.9.2, Node types20.19.39. Source locks are unchanged. Run the two focused Node construct specs and strict targeted TypeScript check; returned `VERIFICATION.json` and final raw log identify outcomes. Initial Windows fixtures attempted POSIX `/tmp` and directory symlinks without a Windows junction; their6/8 then7/8 failures are retained as environment/fixture findings. Portable temporary paths and a junction-created-then-dangled case preserve the original refusal assertion, not a skip. Auth, schema, SQL and production definitions remain byte-identical to the base.

Final focused result is8/8PASS,0failed/skipped; strict targeted TypeScript also passes. Windows sandbox denial of the preserved dangling-junction check remains in ATTEMPT-3-TEST-LOG.txt; an approved local run outside the sandbox exercised it successfully without skipping or changing its refusal assertion. Two inherited availability-zone warnings remain in the optional isolated stack. FINAL-TEST-LOG.txt preserves the complete final output.

Independent review of this exact branch is required before any promotion. No AWS changes, database mutations, migrations, credential values, provider calls or deployment occurred in this source task.
