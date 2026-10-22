# Clone source completion — execution qualification pending

Clone source completion baseline: PR108 `ca079eb4c55acce756c8294a96a7fba555f01def`, tree `b05aa2de777ae03ee428464ffeae84650931414a`. Review correction6340196912 baseline: `77323b35b06ab32e14b3c6d388da30973d6a6459`, tree `b1ea13c12ad0c2635b543c609c37051083b2bb38`. Direct Neo approval was relayed by dot as Sentinel_97ad001b79488191a96b05845c67d991 for the bounded [brief6338869276](https://github.com/neo-capiro/meri-greenfield/issues/202#issuecomment-6338869276). Publication head/tree are recorded in the PR body. This source packet targets only `capiro-newstack-preview-clone`; agents do not execute SQL, merge or deploy.

## Current source correction

- Ordered-owner migration: replace only the initial ADD COLUMN/CHECK statement with IF NOT EXISTS, exact catalog shape refusal, and separate NOT VALID/VALIDATE of the named nonnegative CHECK. Header and complete owner-table/backfill/trigger/RLS/grant remainder unchanged.
- Memory080000: assertion-only addition for the existing named, validated scope/owner/client CHECK, including column binding and literal- and grouping-preserving exact canonical expression comparison. Existing index/row-shape/duplicate checks and index-swap operations unchanged.
- Memory090000: assertion-only addition for exact PK, review uniqueness and tenant FK columns, nondeferrability, referenced tenant key and FK match/actions. Existing original020000 checksum/column/CHECK/trigger/RLS guards and nullable-candidate ALTER unchanged.
- All 463 FINISHED SQL paths/blobs, four moved SQL blobs and sixteen other retained pending migrations are preserved. No source-header rewrite. Original source hashes in the inventory remain historical evidence; changed current hashes are separate fields.
- README and machine-readable inventory mark all nineteen retained pending migrations RUN ON CLONE (Neo 2026-10-22), with `deploy_folder_ready: true`. This declares the approved source selection, **not completed PostgreSQL/image qualification or agent execution authority**. Historical consumer audits, live conflict evidence and all 83 source/ledger gaps remain.

## Actual local checks

- Prisma **5.22.0 validate PASS** on the unchanged canonical schema using the documented dummy offline URL. No database connection/SQL.
- Existing closure generator recomputed byte-identically: SHA256 `a7c1a4243eefc3750d08a18bd7d6437b98c907f77f240e66921f383836ff3505`, **516 nodes / 1022 edges / zero unresolved edges**. No contract or pins changed.
- All API/root qualification `*.test.cjs`: **120/120 PASS**, zero failed/skipped, Node24.19.0. This includes recomputation of both raw image-local schema hashes and the Prisma5.22-formatted generated companion hashes for x64/arm64; all current pins match. No Docker image, native engine or fresh generated-client execution is claimed.
- Existing `memory-submission-stage1-migration.spec.mjs`: **3/3 PASS**, zero skipped. These are source assertions, not PostgreSQL behavior proof.
- New `core-migration-cleanup-postgres16.mjs`: **node --check PASS**. The script was not executed. Its seventeen cases are operator-run, listed below.
- Exact source-tree preservation, bounded-prefix/addition comparisons, inventory consistency and whitespace: PASS. Every other tracked path outside the declared correction is preserved in the publication tree.
- Full Core Jest **BLOCKED before collection**, not a pass: the canonical package command `node --experimental-vm-modules node_modules/jest/bin/jest.js --forceExit --runInBand` exited1 with `MODULE_NOT_FOUND` for `apps/api/node_modules/jest/bin/jest.js`. Core dependencies are absent, and shared scratch is full. No install, custom Jest config, exclusion or test weakening. The default configuration also includes database specs; its full execution requires the authorized operator's isolated runner.

## Source review6340196912 corrections

- Memory080000 now compares `pg_get_expr(c.conbin, c.conrelid, false)` exactly to the required canonical expression. It does not strip whitespace or double quotes from literals. The native fixture set retains all fifteen prior cases and adds two rejection cases for `fi rm` and `fi"rm`. Canonical deparser acceptance and both refusals remain Fable-run.
- The disposable fixture harness uses `docker create`, records and verifies the immutable container ID, name, unique ownership token, image and isolation, then starts. Cleanup retains ownership across failed/timed-out startup; ambiguous creation replies are resolved by name **and unique token**, then removal uses only the verified ID. A preexisting or foreign container is refused and never removed.
- **11/11 mocked lifecycle tests PASS**, Node24.19.0: startup failure/timeout, lost create reply/timeout, preexisting/name-race protection, identity rechecks and inspect transport failure. Only in-memory process doubles ran; no Docker or SQL. `node --check` and whitespace PASS. Command: `node --test apps/api/scripts/qualification/owned-postgres-container.test.mjs`.
- Independent source review found no remaining source blocker. Current080000 SHA256: `6cb48367c6149eb5237236a8ed31c1ef9d0817cf7a8a38e912fc295859b9860a`. Inventory current hash updated; all original evidence remains intact.
- The earlier120 qualification,3 memory-source and Prisma validate receipts above are historical checks from the preceding source packet, not reruns at this correction. Schema/manifests/contract/pins and those test inputs are unchanged. Full Core Jest, all17 native fixtures, the19-migration clone proof and exact-image/API gates remain open.

## Fable-run PostgreSQL16 fixtures

After supplying a local `postgres:16` image, the separately authorized operator runs:

```sh
node apps/api/scripts/qualification/core-migration-cleanup-postgres16.mjs --run
```

The script accepts no database URL, existing container, host mount or exposed port. It pins the local Docker socket and inspected image ID, creates and verifies a uniquely owned network-none container before startup, checks PostgreSQL16, runs whole actual migration bytes in fresh synthetic databases, emits source/image/server/case receipts, and removes only its owned container. It never targets the clone or live service. No opt-in means NOT RUN, not PASS.

| Fixture group | Cases | Required result |
|---|---:|---|
| Ordered owners | 7 | Absent and matching columns succeed with validated CHECK, unchanged existing value and rank-one backfill; wrong type, nullable, wrong/missing default fail exact-shape guard; existing negative data fails validation. Successful fixtures also reject later negative writes. |
| Memory080000 | 6 | Exact original CHECK permits swap; absent, unvalidated, weaker same-column or literal-drift CHECK (`fi rm` / `fi"rm`) refuses before index replacement. |
| Memory090000 | 4 | Original020000 receipt shape permits nullable candidate; same-named wrong PK, review unique or tenant FK refuses before ALTER. Existing candidate payload remains byte-equivalent as JSON text. |

All seventeen are **NOT RUN / Fable-run**. In particular, PostgreSQL16's canonical CHECK deparsing must pass the exact positive080000 fixture; a positive failure is a source blocker, not permission to loosen the expected CHECK.

## Remaining mandatory gates

1. Full Core unit/native suite from a clean locked installation on the permitted isolated runner. Missing local dependencies do not satisfy this gate.
2. The seventeen fixtures above, then a disposable PostgreSQL16 clone with the supplied FINISHED ledger and corresponding baseline schema: `prisma migrate deploy` must apply exactly the nineteen `clone_execution_decision.pending_in_order` entries in inventory, in order. Capture before/after names/checksums and all prerequisite refusals. The fixture harness does not perform or replace this whole-folder proof. Never synthesize missing migration history or infer schema facts from names alone.
3. Exact-head review and new image/runtime qualification by the authorized operator. Prior107 receipts do not qualify this tree; full API startup remains unverified.

No SQL/database action, Docker invocation, AWS action, merge or deployment ran here. All independent frontend, release and no-early-Wave-2 holds persist.

## Initial cleanup evidence (historical, unchanged)

The following receipts describe the original source before this approved completion. Their HOLD and unchanged-SQL statements apply to that historical snapshot; the current source disposition above supersedes them only within Neo's bounded clone approval.

# Validation receipt — no SQL execution

Source baseline: published `51e265bd5b5170abffb32a62ffc39a52a788fe60`, local equivalent `eecccecdc99620a25aed665578fc553938684e8a`, common tree `4ac54093d3dc477e08249ded10bc7a07972637e6`.

## Completed

- Read the complete supplied attachment. Parsed 546 distinct FINISHED names; reconciled 486 source SQL entries into 463 FINISHED and 23 pending, with 83 FINISHED names absent from source. All 23 pending SQL files and consumers were reviewed. Exact source Git blobs are recorded for all 486; pending SHA256 values were computed from raw Git bytes.
- Four source SQL files moved unchanged. All 463 FINISHED SQL paths/blobs and 19 retained pending paths/blobs are preserved. The only existing non-SQL edit is the prospect-stage spec's fixture path; its assertions are unchanged.
- Prisma **5.22.0 validate** passed against the unchanged canonical schema. The invocation used a dummy localhost port 1 URL, not credentials, and `validate` does not execute SQL or connect to a database.
- Existing runtime-production-closure generator recomputed the contract byte-identically using the installed yaml module. Contract SHA256 remains `a7c1a4243eefc3750d08a18bd7d6437b98c907f77f240e66921f383836ff3505`, with 516 nodes, 1022 edges and zero unresolved edges. No manifest, lockfile, dependency or contract change.
- Both x64 and arm64 schema targets recomputed with the existing `prisma-musl-target.cjs` and Prisma 5.22.0 formatter. All four pinned hashes match exactly; see `PIN-RECOMPUTATION.json`. No constants were hand-edited. Formatting equivalence is not a fresh generated-client or native image proof.
- Three targeted closure suites: **24/24 PASS**, zero skipped. An initial attempt hit ENOSPC while creating fixtures; rerun with `TMPDIR=/dev/shm` passed without assertion changes.
- All existing `apps/api/scripts/qualification/*.test.cjs` and `scripts/qualification/*.test.cjs`: **120/120 PASS**, zero failed/skipped. This includes the broader root qualification suites in addition to the API suites. Node v24.19.0; default qualification architecture mode. Assertions and fixtures unchanged.
- The copied/moved SQL fixture exists at the updated stage-test path and has the exact original bytes. Full Core Jest suites were not run: this sparse checkout has no Core dependency installation and shared scratch is full. No install or assertion workaround was attempted.

## Commands

```sh
node scripts/qualification/runtime-production-closure.cjs \
  --yaml-module /tmp/agent4-core-tools/node_modules/yaml \
  --contract --out /dev/shm/agent4-core-cleanup-contract.json

DATABASE_URL='postgresql://validation:validation@127.0.0.1:1/schema_validation?schema=public' \
  PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1 \
  node /tmp/agent4-core-tools/node_modules/prisma/build/index.js validate \
  --schema /tmp/agent4-core-qualification/apps/api/prisma/schema.prisma

TMPDIR=/dev/shm NODE_DISABLE_COMPILE_CACHE=1 \
  CAPIRO_QUALIFICATION_PRISMA_CLI=/tmp/agent4-core-tools/node_modules/prisma/build/index.js \
  node --test apps/api/scripts/qualification/*.test.cjs scripts/qualification/*.test.cjs
```

The contract was initially generated under `/tmp` and copied to `/dev/shm` to relieve the full shared disk; only the output path differs above. Pin recomputation used temporary schema copies, the unchanged target-selection helper and `prisma format --schema`, with no `prisma generate` or database command.

## Not established / still required

- No `prisma migrate deploy`, ephemeral Postgres fixture, database read/write, SQL execution, AWS operation, Docker build, in-image probe, entrypoint gate, fresh generated client or full API startup was performed.
- Full Core unit suites and new Docker/runtime qualification remain uncompleted gates. Fable owns the later image qualification. #107's prior receipts apply to its exact earlier tree, not this draft.
- Deployed environment/tenant flags and unsupplied target catalog facts remain unverified. Source-default closure does not prove the deployed configuration is off.
- Nineteen unresolved pending migrations remain. The source-only/ungated conflicts, ordered-owner collision, exact contacts table-name gap, memory preconditions and 83 source/ledger gaps must be resolved before claiming the migration folder deployable.
- This draft carries no merge, deployment, database-execution, feature-enablement or cross-lane runtime-change approval.
