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

| Area | Source at `b75a17f8` | Remaining gate |
| --- | --- | --- |
| Memory receipt Stage 1 | `apps/api/prisma/migrations/20281018090000_clio_meri_memory_submissions_content_free/migration.sql` takes an `ACCESS EXCLUSIVE` lock, checks original `020000` ledger/schema footprint, then only drops `candidate`'s `NOT NULL`. It neither drops the column nor rewrites an existing JSONB value. Repository LF SHA-256: `3c390ca6627663bd1ff673caa48c3cbe7d6391c80f64ffd151ef50285471261c`. | Read each target's `_prisma_migrations` for original `020000`, `080000` and **unapplied, nonfailed** `090000`; inspect exact columns, check, trigger function, policies/RLS, counts and holds. Rehearse the actual old/new schemas and writers on a disposable clone. An applied or failed `090000` needs a separately reviewed forward/recovery plan. |
| Client purge | `MemoryPurgeService` positively checks the exact six-column, forced-RLS, content-free receipt shape under a transaction-held read lock before any destructive delete. Stage 1 leaves a seventh `candidate` column, so purge execution still refuses; dry run reports `receiptPayloadDispositionHold`. | Keep execution held. A later Stage 2 column drop needs action-time disposition of **all** `clio_meri_memory_submissions.candidate` values in each named target, including orphaned/held rows, with counts, hold decision and restore method. Stage 1 grants no such deletion. |
| Signed passive memory | `meri-memory-signed-page-source.ts` snapshots the selected-client `search_memory@0.2.0` page after a consumed Option B grant and exact emitted-body hash, computes page/record hashes, and requires delegated pre-byte recheck. It is unmounted. | The one-use eligibility helper/credential and separate proposal target/alias need a centrally allocated shared contract. Meri must forward signed invocation/call key and enforce receipt expiry at final dispatcher release. Existing ordinary Bearer/service-secret callback does not complete that contract. |
| Document identity | `EcsControlPlaneDocumentReadback` requires ECS service-filtered task membership before/after, running task/container and digest-pinned task definition, plus separate immutable image-to-source and effective-configuration evidence. It is unregistered. | Deployment owner must supply both independent evidence ports and approved read-only ECS access, qualify a new image/config pin and read back the running task. The document receiver remains 503 by default; the other retained reads also lack preview runtime proof. |

The original `020000` migration remains byte-identical: Git LF SHA-256
`090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5`
(exact CRLF checkout transformation
`d70772020ba2cec0a4a590a62fa45c1922c774b77a0514836fbeb6204d3ecb97`).
The new Stage 1's current Windows checkout has CRLF SHA-256
`fb5f9fcdf266629d5481bbc48a7992d30084f2c9fa800d8d6d72824d492e762c`;
its repository LF digest above is the source pin. A deployment ledger checksum
must be compared to the **actual deployed migration bytes**, not inferred from
the Git commit or this host's checkout. No target ledger or schema has been
read back for this source.

The Stage 1 guard checks the original seven column names/types/nullability/
defaults, validated object check, named enabled trigger and named RLS policy.
It does not prove the trigger function body, policy expressions or an unknown
extra constraint; these require Stage 0 definition readback. A guard/lock
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
