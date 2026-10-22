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
