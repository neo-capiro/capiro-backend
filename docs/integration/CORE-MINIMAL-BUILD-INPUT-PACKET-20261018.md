# Integrated Core source archive and migration packet — 2026-10-18

**Status: provisional source preparation.** This packet is based on Core
`869ee0eb461d15af75ccf83186e6b897d7529bc1` and must be regenerated after
the document identity adapter at `93ac25e0ef3a59ec10adf269bc8455bdd856b308`,
Core memory continuation, PR166/PR167 receiving work, and all other accepted
Core source slices are merged. The adapter is source-only: its trusted
control-plane identity port/provider remains unimplemented and unregistered.
No ZIP has been sealed or uploaded. No paid build, image, AWS mutation, live SQL,
grant, listener change, or deployment is evidenced here.

## Reproducible build inputs

`apps/api/Dockerfile` builds from the **repository root**. The reviewed input
set is precisely its local `COPY` sources plus that Dockerfile and root
`.dockerignore`. Run the tracked-only preparer from the repository root:

```sh
node infra/deploy/prepare-first-chat-core-source.mjs \
  --ref <final-40-character-Core-commit> \
  --base b40971b1f8de888687a8fb92fbdf4ff653fe10d3 \
  --manifest <outside-repository-manifest.json>
```

The manifest-only form reads Git objects at the exact commit. It checks each
Dockerfile local `COPY`, rejects missing inputs, symlinks and credential-like
paths, and records every included file's Git blob ID and size. It cannot pick up
untracked files, local `node_modules`, build output, or host credentials. The
path allowlist includes:

| Docker context input | Reason |
| --- | --- |
| Root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.dockerignore` | Frozen package graph and compiler configuration. |
| `apps/api/Dockerfile`, package and Nest/TypeScript configs | Exact image recipe and API build configuration. |
| `apps/api/src`, `prisma`, `scripts`, `data` | Dockerfile build and runtime `COPY` sources, including the runtime entrypoint and Prisma migration files. |
| `packages/shared`, `meriv2-core`, `defense-contracts`, `defense-domain` package manifests, configs and `src` | The filtered workspace install and explicit package builds. |

Historical root `docs`, `evidence`, `outputs`, old buildspecs, other apps,
marketing, tests, and unused Dockerfiles are excluded. The present Dockerfile
copies the **whole** API `src` and `scripts` trees; this retains their internal
tests, `scripts/__data__` and `scripts/__fixtures__`. Excluding those files would
change the current Dockerfile's input set and needs a separate audited recipe
change. Do not claim they were pruned. The source ZIP is a selected Git archive,
not a ZIP of the working tree or an S3 object copied from a historical PR43 build.

At the provisional `869ee0eb` commit, `git rev-parse <commit>^{tree}` is
`0badb18e8b888719f4b77cffb8494cdafc9d1f9f` and the preparer reports:

| Group | Files | Git blob bytes |
| --- | ---: | ---: |
| API `src` | 4,228 | 61,804,581 |
| API `scripts` | 982 | 46,727,432 |
| API `prisma` | 511 | 3,413,999 |
| API `data` | 120 | 2,112,504 |
| Four packages | 421 | 3,574,193 |
| Root and API config/Dockerfile | 10 | 786,989 |
| **Total** | **6,272** | **118,419,698** |

The ordered `mode blob-id size path` inventory SHA-256 is
`1c75e2d2df5ed5bda77d481af7a5dca3dbc8fb1d1742ac6bf412bd722155045d`.
The Dockerfile blob SHA-256 is
`86f5ed2b91cce3c9821a679c93363216af49d464213b7930cd8db51f915a57d2`;
the checked-in Core buildspec blob SHA-256 is
`19523ef1a6209f3d9e32a80c028911a39147164311052714238db45636da287c`.
Against PR86 `b40971b1f8de888687a8fb92fbdf4ff653fe10d3`, the provisional
candidate changes 109 paths; `git diff --binary --no-ext-diff` SHA-256 is
`d005961ed174152502da55426eddbe95a7c692df320de4d3a22595dec4e0d401`.
All these values must change or be rechecked at the final Core commit.

Only after the final commit, local integration build, migration hold disposition,
and independent source review may the source owner pass `--archive
<outside-repository/core-<SHA>.zip>` to the same preparer. It refuses to
overwrite an existing ZIP and reports its **actual** SHA-256 and derived
`inputs/core-<SHA>.zip` key. Compare the archive manifest to the exact commit,
inspect the ZIP entries, and bind that ZIP SHA, S3 VersionId, source SHA and
reviewed inline buildspec in the existing CodeBuild project before a separately
authorized build. `APPROVED_SOURCE_SHA` is the final Core commit; it is never an
earlier PR86, PR90 or PR43 pin. Build/readback details remain in
[the integrated image packet](CORE-INTEGRATED-IMAGE-BUILD-20261018.md).

## Source and migration order

1. Freeze the final integrated Core commit and ancestor/source diff. At the
   provisional baseline, PR86's approved task template is 1 vCPU / 2 GiB;
   Core image pins are `null` and `desiredCount` remains zero. The source-only
   identity adapter is not a runtime identity qualification: its trusted
   control-plane port/provider is still missing. Retain document 503 until
   independently current source, image and effective configuration readback is
   proven before and after its owner read. The other retained reads are likewise
   source-wired, not preview-available.
2. Read the actual Core `_prisma_migrations` ledger and table/index shapes and
   compare them with the exact candidate migration bytes. Candidate Core
   `20281018020000_clio_meri_memory_submissions` is the original payload-bearing
   source SHA-256 `090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5`;
   PR86's content-free bytes differ. Do not edit an already-applied migration or
   resolve its ledger to hide that mismatch. Core
   `20281018060000_meri_read_delegation` source SHA-256 is
   `f6f6cf95c67ba0b3b1cf15191297989fe33111d4b4e370ad0118f91740a4fabe`.
   Core `20281018080000_clio_memory_scope_unique` is
   `07d4b52ee712a4e0d302aef3c463d55b983c9a3b1d735d87d31a0c905ade2f9a`;
   inspect duplicate counts, exact old index and lock window before applying.
3. **Stop before plain Core `prisma migrate deploy`:** the candidate also
   includes `20281018090000_clio_meri_memory_submissions_content_free`, SHA-256
   `d8065f6edb1aaf406dc4cf7c4c84a5fc125dc8f2b5f45ec58e06a91d4deebad6`.
   Its SQL unconditionally raises SQLSTATE `55000` before dropping the candidate
   JSONB column. That is an intentional release hold, not a passing migration.
   The memory owner must read target checksums, retention/hold disposition and
   table shape, then agree a separately reviewed forward path. Do not remove
   the hold, skip the migration, or rewrite Prisma history as part of packaging.
4. Read Meri's own applied phase ledger and PLAN pins. Draft Meri PR165
   `e2d62589742fd349907274e5ee325e39059f14f4` registers the exact
   `read-delegation/migrations/0002_prepared_approval_facts.sql` SHA-256
   `b203cf0faef94523270eb9c43f7508d0b805e658652214e71ca92e10a050fc1a`.
   In its explicit **integration** stage, approval-metadata `0001` precedes
   read-delegation facts `0001`, then prepared-approval facts `0002`, then
   `integration_grants`. The earlier Meri and Temporal stages must be ledgered
   first. The new migration extends the existing security-barrier `run_facts_v1`
   to 18 columns with a 64-item aggregate and 65th-row overflow signal; it adds
   no raw-table grant or change to `current_admission_v1`.
5. Before enabling any Core command or read path, read back Core and Meri
   applied checksums, Meri view shape, original admission function and budget
   lock behavior, actual `capiro_app` view-only permissions, effective runtime
   identity and signed relay. The newer Core verifier consumes only
   `run_facts_v1`; PR90's old direct-`approval_metadata` note is superseded by
   this candidate and Meri PR165. The **live** apply and restricted-role readback
   are still required. Preserve the original ADMITTED grant set and transaction
   lock in `current_admission_v1`.

Meri PR166 (`15288a79`, six source adapters) and PR167 (`2c53e6c5`,
`actions.query`/local datasets) are separate provisional source dependencies.
The reservation-bound `actions.query` to `query_action_items` alias and the
remaining A8 authority facts are not established by those source pins alone.
Core memory eligibility/pages/proposal continuation receiving is also pending
at this packet revision. Add their exact accepted pins and runtime gates after
receiving; do not silently count them as complete.

## Failure and rollback boundary

- A failed Meri prepared-facts `0002` or Core memory-index `080000`
  transaction must remain failed and be inspected. Neither failed state nor a
  test fixture is evidence of live installation. Keep existing listener/service
  revisions and command/retained-read gates closed.
- Before any later committed SQL, record a restorable snapshot, exact applied
  checksums, object definitions, app role and owner privileges, lock timing,
  and rollback ticket. Do not delete `_prisma_migrations` rows or substitute
  `migrate resolve` for verified database state. After a committed projection
  change, restore its predecessor definition only through a separately reviewed
  owner migration **after** reverting/draining Core code that reads the added
  columns. Recheck its grants and one-row-per-run shape. Do not drop the new
  index or downgrade the view while the new verifier serves traffic.
- On image or listener failure, revert to the recorded previous task definition
  and ordered listener revision, then independently read back target health,
  service count, exact image digest and configuration. Never treat a source
  archive or ECR tag as a running task. The current Core task baseline is still
  `desiredCount=0`; an eventual scale-up requires its own deployment decision
  and readback.

This packet prepares source inputs and makes blocking checks explicit. It does
not waive Meri relay, Objective issuance, Planner follow-up, independent Core
runtime identity, listener, deployment or authenticated user-flow gates.
