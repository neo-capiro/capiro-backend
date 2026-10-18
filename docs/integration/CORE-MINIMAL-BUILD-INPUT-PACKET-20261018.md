# Integrated Core source archive and migration packet — 2026-10-18

**Status: locally built source and prepared, unqualified archive.** The exact
integrated Core source cut is
`4b858a87b05f0e189e9423a0f16a8de98eb96855`. It includes the
document identity adapter `93ac25e0ef3a59ec10adf269bc8455bdd856b308`,
memory continuation `ab1675ade0da4da2820e667a06497109b53d9f27`, and
default-off A8 alias `868aafea8a6d731a0cab4210c169a955359daecc` plus
the exact PR171 wire correction `3f726d585860ac9e43097c293d6824f96682381f`.
It also receives the retained-source TypeScript repair
`1955e5d3c202ddd68030d2d8719153b3b31320f7`. The first integrated API
build exposed 27 TypeScript diagnostics before that repair. The final local
Nest API build on clean, remote-verified `4b858a87` passed with an 8 GiB heap,
exit code zero and no diagnostics. This is a local build result, not an image
or deployed-service readback.
This packet branch is stacked on the built Core source and contains only this
documentation and the archive preparer. It is **not** merged back into the
Core candidate, so the Docker image source pin remains the exact built Core
commit rather than a later documentation-only SHA.
The identity adapter's trusted control-plane port/provider remains
unimplemented and unregistered.
A tracked-only ZIP has been prepared and verified locally, but remains
**unqualified for shipping and unuploaded**. No paid build, image, AWS
mutation, live SQL, grant, listener change, or deployment is evidenced here.

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

At `4b858a87`, `git rev-parse <commit>^{tree}` is
`cbbec374d78ff4e5215ef77a375afbf632b2da2b` and the preparer reports:

| Group | Files | Git blob bytes |
| --- | ---: | ---: |
| API `src` | 4,235 | 61,863,344 |
| API `scripts` | 982 | 46,727,432 |
| API `prisma` | 511 | 3,413,999 |
| API `data` | 120 | 2,112,504 |
| Four packages | 421 | 3,574,193 |
| Root and API config/Dockerfile | 10 | 786,989 |
| **Total** | **6,279** | **118,478,461** |

The ordered `mode blob-id size path` inventory SHA-256 is
`850fe5270e6daf0cd4d975a1e531175d79169ca71c4ca2454ffdbe0eb4d15849`.
The Dockerfile blob SHA-256 is
`86f5ed2b91cce3c9821a679c93363216af49d464213b7930cd8db51f915a57d2`;
the checked-in Core buildspec blob SHA-256 is
`19523ef1a6209f3d9e32a80c028911a39147164311052714238db45636da287c`.
Against PR86 `b40971b1f8de888687a8fb92fbdf4ff653fe10d3`, the built
candidate changes 120 paths; `git diff --binary --no-ext-diff` SHA-256 is
`1526f73758b293b63fe705848c49c91abd1daf9eaea5e3b532cb958bac29da42`.
These values bind the exact Core source cut. This packet branch has a later
tree/diff because it adds documentation and the preparer; its own SHA must
not be substituted for the Core image source pin.

The one-time local preparation used:

```sh
node infra/deploy/prepare-first-chat-core-source.mjs \
  --ref 4b858a87b05f0e189e9423a0f16a8de98eb96855 \
  --base b40971b1f8de888687a8fb92fbdf4ff653fe10d3 \
  --archive ../core-4b858a87b05f0e189e9423a0f16a8de98eb96855.zip \
  --manifest ../core-build-packet-final-4b.json
```

It sealed local
`../core-4b858a87b05f0e189e9423a0f16a8de98eb96855.zip` (43,335,448
bytes) and `../core-build-packet-final-4b.json` outside this worktree. The
archive SHA-256, independently checked with `Get-FileHash`, is
`5027c7cec5827b8b7f67075abd9c8a03f8bef356416f6a40bea45a2229844f2a`.
The ZIP inspector matched all 6,279 files and their decompressed bytes to the
exact Git blob IDs (7,164 ZIP entries including directories), with no extra
file entries. It also rejects unsafe paths,
encryption and missing entries. The preparer forces `core.autocrlf=false` so
Git archive cannot rewrite text blobs while packaging a Windows checkout.
The manifest records the actual archive hash and derived
`inputs/core-4b858a87b05f0e189e9423a0f16a8de98eb96855.zip` key.
Recheck it with `--verify-archive <outside-repository/core-<SHA>.zip>` against
the same exact `--ref` and `--base`; the command reads ZIP entries without
repacking them. The ZIP remains **unqualified** while the memory migration
release hold and all runtime gates remain unresolved. Preparing the local ZIP
does not resolve or bypass that migration hold.
Do not upload it or start a paid build as part of this preparation. A later
shipping owner must bind that ZIP SHA, S3 VersionId, source SHA and reviewed
inline buildspec in the existing CodeBuild project before a separately
authorized build. `APPROVED_SOURCE_SHA` is the built Core commit; it is never an
earlier PR86, PR90 or PR43 pin. Build/readback details remain in
[the integrated image packet](CORE-INTEGRATED-IMAGE-BUILD-20261018.md).

## Source and migration order

1. Freeze the final integrated Core commit and ancestor/source diff. At the
   built source baseline, PR86's approved task template is 1 vCPU / 2 GiB;
   Core image pins are `null` and `desiredCount` remains zero. The source-only
   identity adapter is not a runtime identity qualification: its trusted
   control-plane port/provider is still missing. The ordinary shipping path is
   to review exact source/image/effective-configuration pins and register a
   trusted independent readback provider through reviewed deployment/source
   configuration using existing approved access. The ECS v4 task metadata
   selector alone is not independent proof. Retain document 503 if the provider
   or effective-configuration readback is absent, and until current identity
   is proven before and after its owner read. The other retained reads are
   likewise source-wired, not preview-available.
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

Core's integrated [source handoff](CORE-INTEGRATED-SOURCE-CANDIDATE-20261018.md)
pins the eleven retained read receivers, PR94 Quick Log and PR95 client-wide
storage report. They are included as source; the retained reads are not
preview-available, the storage allowance is report-only, and Planner follow-up
remains a resumable downstream saga. Objective D7-3's admission adapter is
unmounted, `/decisions` and issuance remain disabled. Core's A8 alias is
present at `868aafea8a6d731a0cab4210c169a955359daecc` with the exact
PR171 wrapper correction at `3f726d585860ac9e43097c293d6824f96682381f`.
It defaults off, including before one-use token issuance.

Meri PR166 `15288a7954862e348af86bf1eab119fdb30863a0` prepares six A8
adapters with canonical selected-client UUIDs in exact Core tool bodies. It
does not supply Core's nullable hearing-selector admission, authenticated
legal citation-resolution facts, news cutoff/folder/monitor/default-year owner
facts, or Outreach walls for unscoped and detail reads. PR167
`2c53e6c5123d392308d84a74eb8da2e5741f5dc1` prepared selected
`actions.query@0.2.0` and `list_global_datasets@0.2.0` ports. The current
Meri receiving counterpart is **draft PR171**
`eeeda2d415a976ea240de482e62f71a32020c9b7`, which includes PR169's
original `query_action_items@0.2.0` source and PR170's signed
`actions.query@0.2.0` source. It composes seven selected client reads, both
action operations and local datasets without hiding the full desired 76/42
catalog (source measurement SHA-256
`8850af4b50666deef9e4c7edc23d32f25d663840748380c7baaa066585602f6a`;
synthetic selected 10/8 SHA-256
`028dd903f6fb0f0ba0650c9d7f0a12f124a98d94890d8a27bfc91fe140ef829e`).
For `actions.query`, its source keeps the original UNKNOWN reservation
and full normalized arguments hash, freezes the exact emitted body, then relays
a trusted invocation/call key to the one-use `CapiroMeriRead` token exchange.
The original `query_action_items` path remains a separate flat-body token path.
The [Core PR87 coordination receipt](https://github.com/neo-capiro/capiro-backend/pull/87#issuecomment-6252192739)
pins that wire. The Core successor `3f726d58` now validates PR171's exact
`JSON.stringify({input,metadata:null})` and signed correlation
`{binding,subject,policyRevision,normalizationContext:null}` before projecting
a bounded flat request to the canonical owner. This is source receiving only:
Core's alias switch is still
default-off and its route returns 503, while P2/G3 selection, Meri/Core image
and configuration pins, signed runtime relay and authenticated readback are
unqualified. Do not claim the A8 family or either action operation live from
these source pins.

Core memory continuation `ab1675ade0da4da2820e667a06497109b53d9f27`
adds unmounted page admission and client-scoped proposal continuation source.
Its signed one-use eligibility helper, reservation-bound Meri proposal alias,
and final receipt-expiry enforcement remain open. Do not count unmounted
preparation as live memory availability.

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
