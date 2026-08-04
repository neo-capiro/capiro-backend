# RDT&E Fargate Readiness (Phase 4)

How the pure RDT&E semantic modules and the Phase 3 parser task can later
run inside a Program Elements service/task image. This is a readiness note —
no CDK or deployment infrastructure is implemented in Phase 4 (explicitly
out of scope).

## What is already portable

Everything under `apps/api/src/defense-budget/rdte/**` is a pure module:

- no NestJS DI — plain functions with explicit inputs/outputs;
- no Prisma client — the planner consumes a plain read-only row snapshot
  (`RdteCanonicalRowSnapshotV1`); the pipeline consumes verification
  references as data;
- no AWS SDK — source locators are opaque strings resolved by the command
  layer (filesystem today; S3-materialized roots later);
- no wall-clock dependence — artifact IDs, bundle IDs, and content SHAs are
  computed from canonical JSON of identity tuples only;
- no network access — extractors operate on `ParserPageResultV1[]` in memory.

Consequence: the entire extract → reconcile → certify → plan pipeline can be
lifted into any Node runtime (Fargate task, Lambda, CLI image) by wrapping
it with a thin command layer that materializes sources and page results.

## Command-layer seams (the only infra-touching surface)

| Seam | Current implementation | Fargate equivalent |
|---|---|---|
| Source bytes | local path / fixture:// | S3 GetObject into a task-local materialized root |
| Page results | `--pages-dir` JSON | S3-object-backed Phase 3 artifact store |
| Verification refs | `--verifications` JSON | same (or Phase 2 audit-table read) |
| Outputs | `--out` directory | S3 PutObject (content-addressed keys) |
| Paid escalation | explicit flags, forwarded | same flags; Secrets Manager for the LlamaParse key; never default |

## Task image composition (future)

1. Base image: the API build image (Node 22, tsx, prisma CLI not required
   at runtime — Phase 4 never touches the DB).
2. Entrypoint verbs: `build-rdte-cycle`, `report-rdte-cycle`,
   `plan-rdte-projection` — inspect/noncanonical by construction; none
   exposes `--commit`.
3. Environment: `LD_LIBRARY_PATH`/parser runtime deps only if the Phase 3
   python parser sidecar is bundled; the semantic pipeline itself needs
   nothing beyond Node.
4. Exit codes (0/2/3/4/5) map directly onto task status + alarms.

## Guardrails that travel with the code

- Permanent architecture gates (rdte/gates) run in CI and fail any image
  build that introduces a writer import, Prisma mutation, --commit, or paid
  call into the Phase 4 surface.
- The migration is additive-only and rehearsed on disposable PostgreSQL;
  the task image must not run `prisma migrate deploy` — schema changes stay
  a human-approved pipeline step.

## Deliberately deferred

- EventBridge scheduling of annual cycles;
- CDK/Fargate service definition;
- S3 lifecycle/retention policies for cycle artifacts;
- Program Elements service deployment.
