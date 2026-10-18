# Core staged source successor — 2026-10-18

**Source composition, not a running service or migration approval.** This
handoff follows the integrated source candidate and old build packet. Its
reviewed composition base is `b75a17f88620556b6094ed6f255d50618e16aed0`.
The earlier [build input packet](CORE-MINIMAL-BUILD-INPUT-PACKET-20261018.md)
measures a local ZIP and successful API build at
`4b858a87b05f0e189e9423a0f16a8de98eb96855`. That ZIP contains the **old**
`090000` unconditional SQLSTATE `55000` stop (repository SHA-256
`d8065f6edb1aaf406dc4cf7c4c84a5fc125dc8f2b5f45ec58e06a91d4deebad6`).
It does not contain this successor's Stage 1, purge guard, signed memory page
composition or ECS control-plane readback. Do not reuse its archive, image,
tree or source pin as evidence for this successor. This successor has **no new
qualified archive, image digest, installed migration or runtime readback**.

## Changed source and release gates

| Area | Staged successor source | Remaining gate |
| --- | --- | --- |
| Memory receipt Stage 1 | `apps/api/prisma/migrations/20281018090000_clio_meri_memory_submissions_content_free/migration.sql` takes an `ACCESS EXCLUSIVE` lock, checks original `020000` ledger and exact table, constraint, trigger/function, and RLS footprint, then only drops `candidate`'s `NOT NULL`. It neither drops the column nor rewrites an existing JSONB value. Repository SHA-256: `0e358884bff11be352931045e212f60e4a5aa607d656a442b72ad94e218d0fa1`. | Read each target's `_prisma_migrations` for original `020000`, `080000` and **unapplied, nonfailed** `090000`; inspect exact schema definitions, counts and holds. Rehearse the actual old/new schemas and writers on a disposable PostgreSQL clone. An applied or failed `090000` needs a separately reviewed forward/recovery plan. |
| Client purge | `MemoryPurgeService` positively checks the exact six-column, forced-RLS, content-free receipt shape under a transaction-held read lock before any destructive delete. Stage 1 leaves a seventh `candidate` column, so purge execution still refuses; dry run reports `receiptPayloadDispositionHold`. | Keep execution held. A later Stage 2 column drop needs action-time disposition of **all** `clio_meri_memory_submissions.candidate` values in each named target, including orphaned/held rows, with counts, hold decision and restore method. Stage 1 grants no such deletion. |
| Signed passive memory | `meri-memory-signed-page-source.ts` snapshots the selected-client `search_memory@0.2.0` page after a consumed Option B grant and exact emitted-body hash. The unmounted proof, one-use helper issuer and receiver bind the consumed parent JTI, page/callback hashes, original admission and current authority. The `100000` token-table DDL is reserved in a separate held source packet and is absent from this Stage 1 migration tree. | Meri draft PR172 `432006eb2b1d87af8c73e11d4222be2a5930952b` supplies the two-step signed wire and final receipt-expiry narrowing. Core still needs HTTP owner composition, the separately qualified `100000` migration, measured source/image/config pins and runtime readback before activation. Personal recall remains held. |
| Document identity | `EcsControlPlaneDocumentReadback` requires ECS service-filtered task membership before/after, running task/container and digest-pinned task definition, plus separate immutable image-to-source and effective-configuration evidence. It is unregistered. | Deployment owner must supply both independent evidence ports and approved read-only ECS access, qualify a new image/config pin and read back the running task. The document receiver remains 503 by default; the other retained reads also lack preview runtime proof. |

The reviewed Core helper source is `57ec94db9fcc12ca503f47546bea2e80ea5306f7`.
Its separate, held `100000` migration has SHA-256
`387ef6d75f940fd996fed0106415ed2f88bd6112005e1054df9d15c73133a171`.
Neither its SQL file nor its migration-only test is in this integrated Stage 1
tree. The helper issuer and receiver remain unmounted.

The original `020000` migration remains byte-identical: Git LF SHA-256
`090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5`
(exact CRLF checkout transformation
`d70772020ba2cec0a4a590a62fa45c1922c774b77a0514836fbeb6204d3ecb97`).
The strict Stage 1's current checkout and repository source both have SHA-256
`0e358884bff11be352931045e212f60e4a5aa607d656a442b72ad94e218d0fa1`.
A deployment ledger checksum
must be compared to the **actual deployed migration bytes**, not inferred from
the Git commit or this host's checkout. No target ledger or schema has been
read back for this source.

The Stage 1 guard checks the original seven column names/types/nullability/
defaults, exact constraint set, unconditional trigger and function body, and
single original RLS policy with its expressions. Stage 0 target readback and a
disposable PostgreSQL rehearsal must still confirm these strict deparse checks
accept the actual original schema. A guard/lock
failure may leave a failed Prisma migration row, so `prisma migrate deploy` is
not a smoke test. Keep the nullable physical column out of generated Prisma
diffs until Stage 2 is separately qualified. The exact procedure and rollback
limits are in the [Stage 1 cutover note](CORE-MEMORY-090000-STAGED-CUTOVER-20261018.md).

The original ADMITTED grant set, `current_admission_v1` and its transaction
lock are unchanged. No live SQL, AWS operation, new credential, IAM grant,
paid build, route activation or payload deletion occurred in this source lane.
Focused source tests are
`apps/api/scripts/memory-submission-stage1-migration.spec.mjs` (static only),
`apps/api/src/memory/memory-purge.service.spec.ts` (mocked transaction),
`apps/api/src/meri/memory-receiving/meri-memory-taskbound-source.spec.ts`,
`apps/api/src/meri/retained-source-v02/ecs-control-plane-document-readback.spec.ts`
and `ecs-document-runtime-identity-reader.spec.ts`. They do not replace target
readback, disposable PostgreSQL rehearsal or a new exact source/image build.
