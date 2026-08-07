# Defense Budget Stage Cycle V1 Runbook

## Safety model

Phase 6 does **not** provide canonical commit or promotion. Stage extraction reuses the governed Phase 3 parser/router, which is local by default; paid parsing requires explicit authorization and a page cap. Phase 6 cycle composition/certification commands are inspect/replay only. Optional projection persistence is audit-only and requires explicit repository authorization.

## Prerequisites

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/shared build
pnpm --filter @capiro/meriv2-core build
pnpm --filter @capiro/api prisma:generate
```

The isolated Phase 6 projection schema is generated and validated separately:

```bash
cd apps/api
pnpm exec prisma generate --schema prisma/phase6-projection/schema.prisma
pnpm exec prisma validate --schema prisma/phase6-projection/schema.prisma
```

## 1. Extract one stage document

`phase6:extract-stage` delegates to the existing Phase 3 governed parser/router; Phase 6 does not maintain a second parsing engine.

```bash
pnpm --filter @capiro/api phase6:extract-stage -- \
  --manifest <manifest.json> \
  --document <document-key> \
  --source <source.pdf> \
  --work-dir <work-dir> \
  --out <artifact.json>
```

Default behavior is local/inspect with no canonical write and no paid parser call. When a difficult page genuinely requires the governed paid route, authorization is explicit and bounded:

```bash
pnpm --filter @capiro/api phase6:extract-stage -- \
  --manifest <manifest.json> \
  --document <document-key> \
  --source <source.pdf> \
  --work-dir <work-dir> \
  --out <artifact.json> \
  --allow-paid-parse \
  --max-paid-pages <N>
```

Never authorize paid parsing without a page cap.

## 2. Authorization-cycle inspect plan

```bash
pnpm --filter @capiro/api phase6:compose-authorization -- --input <cycle-input.json>
```

The input is a strict `phase6_cycle_certification_input_v1` assembled from already-produced stage artifacts/projections. HASC, SASC, and NDAA conference remain separate positions. HASC/SASC disagreement remains explicit; NDAA conference never auto-resolves disagreement by choosing a chamber value.

## 3. Appropriations-cycle inspect plan

```bash
pnpm --filter @capiro/api phase6:compose-appropriations -- --input <cycle-input.json>
```

HAC-D, SAC-D, appropriations conference, and public law remain separate. Appropriations conference is source-defined; no midpoint or inferred compromise is permitted. Missing HAC-D/SAC-D comparisons are `NOT_RUN`.

## 4. Enactment proof inspection

The historical public-law loader is now proof-only and cannot commit:

```bash
pnpm --filter @capiro/api parse:defense-approps-public-law -- \
  --proof <enactment-proof.json> \
  --candidates <line-candidates.json>
```

Any `--commit` attempt exits nonzero. Full enactment-proof requirements are documented in `defense-budget-enactment-proof-v1.md`.

## 5. Post-enactment inspect plan

```bash
pnpm --filter @capiro/api phase6:compose-post-enactment -- --input <cycle-input.json>
```

Reprogramming transfers remain actions. Revised `reprogrammed` totals require explicit after-values or a policy-authorized exact derivation in the same printed unit. Execution requires exact metric/as-of/cumulative semantics.

## 6. Verify the full stage cycle

```bash
pnpm --filter @capiro/api phase6:verify-cycle -- --input <cycle-input.json>
```

Certification status:

- `CERTIFIED` — all required documents/proofs/comparisons complete and no reviewable bindings remain.
- `NEEDS_REVIEW` — required comparison `NOT_RUN`, candidate/unresolved binding, or unresolved enactment coverage remains.
- `INCOMPLETE` — required source documents or required enactment proof coverage are missing.
- `REJECTED` — blocking source proof, comparison, binding conflict, projection, or enactment proof exists.

Missing is never zero and never PASS.

## 7. Report certification

```bash
pnpm --filter @capiro/api phase6:report-cycle -- --input <cycle-input.json>
```

The deterministic report contains required documents, profile/manifest hashes, source proof, projection counts, line-family coverage, binding counts, comparisons, enactment coverage, reprogramming/execution coverage, local/paid/cache parser statistics, and a content SHA.

## 8. Full closeout

From `apps/api`:

```bash
bash scripts/verify-pe-budget-phase6-closeout.sh
```

This runs:

1. isolated projection Prisma generate + validate;
2. strict Phase 6 TypeScript;
3. stage + Phase 6 + shared verification Jest;
4. all NC01–NC24 production-source mutations, focused failure checks, byte restoration, and final clean NC suite;
5. architecture/safety scans;
6. Prettier on code and runbooks;
7. Python uv sync, Ruff format/check, mypy, full pytest;
8. disposable PostgreSQL projection rehearsal unless explicitly skipped;
9. `git diff --check`.

Smaller package gates:

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-6
pnpm --filter @capiro/api verify:pe-budget-phase-6:db
pnpm --filter @capiro/api verify:pe-budget-phase-6:full
```

## Projection database rehearsal

`apps/api/scripts/phase6-projection-rehearsal.sh` discovers every migration under `apps/api/prisma/phase6-projection/migrations/`, applies them in lexical order to disposable fresh and upgrade PostgreSQL databases, replays the migration chain, preserves a prior-phase sentinel, and exercises:

- track/stage/field ownership;
- enacted proof;
- candidate binding containment;
- live natural-key uniqueness;
- CR explicit line authority;
- reprogramming revised-total basis;
- execution metric/as-of/cumulative metadata;
- immutable proof/provenance/supersession lineage;
- projection deletion prohibition;
- status-only supersession;
- transaction rollback;
- cycle-certification idempotency and insert-only semantics.

## Recovery and replay

Source drift is never repaired by editing proof in place. Follow `defense-budget-recovery-and-source-drift.md`: create/rebind exact SourceDocument proof, re-extract against approved bytes, reverify, supersede audit projections, and recertify. The new certification content SHA must change when proof-bearing input changes.

## Prohibited operations

Do not:

- invoke `ProgramElementWriterService` from Phase 6;
- write canonical native-line/product tables;
- accept title-only or missing-account identity;
- infer units from amount magnitude;
- use last-numeric/last-wins table logic;
- let later-stage sources own `request`;
- map authorization conference to appropriations conference;
- silently net actions or transfers;
- label conference as enacted;
- treat a CR as full-year enacted without explicit line authority;
- conflate obligations/outlays/other execution metrics;
- call paid parser providers directly from stage modules;
- deploy or apply Phase 6 audit migrations to a shared environment during acceptance;
- treat Phase 6 projections as canonical product truth.
