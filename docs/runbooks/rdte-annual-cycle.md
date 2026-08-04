# Runbook — RDT&E Annual Cycle (Phase 4)

Operator guide for running one safe, inspect-only RDT&E cycle (FY2027 and
later). Default execution is local, no paid calls, no canonical writes, no
production promotion.

## Preconditions

- `apps/api` workspace built (`pnpm --filter @capiro/api typecheck` green).
- Phase 3 parser router available (local engines; `uv`-based parser runtime
  only if you are producing new page results).
- Source PDFs in hand (official R-1/R-2/R-2A/R-3[/R-4] volumes for the
  cycle). Never commit official full DoD PDFs to the repository.

## 1. Manifest preparation

Create `<fy>-manifest.json` (`defense_budget_cycle_manifest_v1`):

- one entry per source volume with `documentKey`, `sourceLocator`, `family:
  rdte`, the correct `exhibit` (`R-1`/`R-2`/`R-2A`/`R-3`/`R-4`), `authority`,
  `component`, `budgetCycle`, `documentType`, `parserPolicy`;
- `requiredDataCategories` per exhibit (identity/funding for R-1;
  identity/funding/narrative for R-2; projects/project_funding for R-2A;
  performers for R-3; milestones for R-4);
- funding-bearing documents MUST declare `requiredFundingFields` (the
  manifest validator rejects funding categories without it);
- `expectedSourceSha256` when the exact bytes are known ahead of time.

Validate early: `pnpm --filter @capiro/api exec tsx scripts/validate-defense-budget-cycle-manifest.ts -- --manifest <manifest.json>`

A synthetic example lives at
`apps/api/scripts/__data__/rdte-golden-fy2027-manifest.json` (fixture://
sources — rehearsal-safe, no secrets, no copyrighted content).

## 2. Source-file placement

- Local mode: keep PDFs under one directory; `sourceLocator` may be a local
  path or `fixture://<key>.pdf` for rehearsals.
- If page results already exist from Phase 3, place them under a pages
  directory as `<documentKey>.pages-v1.json`.

## 3. Local-only run (default)

```bash
pnpm --filter @capiro/api build:rdte-cycle -- \
  --manifest <fy-manifest.json> \
  --out <cycle-output-directory> \
  [--source-root <pdf-dir>] \
  [--pages-dir <phase3-pages-dir>]
```

Defaults: manifest validation → source SHA computation → consumes Phase 3
page results (content-addressed replay) → builds RDT&E artifacts → reconciles
→ certifies → writes content-addressed artifacts/reports under `--out`.
NO canonical write. NO paid call.

Exit codes: `0` certified · `2` needs review · `3` incomplete · `4` rejected
· `5` operational/configuration failure.

### Targeted paid escalation (explicit authorization only)

Paid parsing is forwarded to Phase 3 ONLY when supplied, and never weakens
the Phase 3 contract:

```bash
pnpm --filter @capiro/api build:rdte-cycle -- \
  --manifest <manifest.json> --out <out> \
  --allow-paid-parse --max-paid-pages <N> --paid-mode pdf_premium
```

Without `--allow-paid-parse --max-paid-pages N`, no paid call can occur.

## 4. Verification review

Each real document's artifact must pass Phase 2 inspect verification:

```bash
pnpm --filter @capiro/api verify:defense-budget-artifact-v1 -- \
  --manifest <manifest.json> --document <documentKey> \
  --artifact <out>/artifacts/<documentKey>.extraction-v1.json \
  --source-document-id <uuid>
```

Feed the resulting verification references into the build with
`--verifications <refs.json>` (JSON array of
`RdteCycleVerificationRefV1`). fixture:// documents carry deterministic
fixture references automatically (rehearsal mode).

## 5. Cycle certification + report

```bash
pnpm --filter @capiro/api report:rdte-cycle -- --cycle-dir <out>
```

Prints machine JSON (stdout) + human summary (stderr): documents
expected/supplied/missing, verification decisions, coverage per category,
reconciliation results, findings, certification.

A cycle certifies ONLY with zero blocking findings, every required document
present and VERIFICATION_PASSED (or an immutable reviewed acceptance).
Coverage percentage alone never certifies.

## 6. Projection plan

```bash
pnpm --filter @capiro/api plan:rdte-projection -- \
  --cycle-dir <out> --out <out>/projection-plan.json
```

Read-only. Refuses `--commit` outright. Uncertified cycles are refused with
exit 2.

## 7. Failure recovery

- Exit 5 with a manifest error → fix the manifest (categories vs funding
  fields, enum values, SHAs) and re-run.
- `missing Phase 3 page results` → run Phase 3 for that document first
  (`extract:defense-budget-cycle`, local mode), then re-run the build.
- Certification NEEDS_REVIEW → inspect `blockingFindings`/`nonBlockingFindings`
  in `cycle-bundle.json`; resolve at the source (re-parse, reviewed
  acceptance) and rebuild.
- Re-run is safe: outputs are content-addressed and idempotent.

## 8. Cache replay

Phase 3 page results are content-addressed; the build consumes
`--pages-dir` without re-parsing. Re-running with the same manifest + pages
reproduces the identical bundle SHA.

## 9. Artifact retention

Keep the full `--out` directory (artifacts/, cycle-bundle.json,
projection-plan.json, build-summary.json) with the cycle's manifest. The
bundle content SHA pins every artifact and verification reference.

## 10. No production promotion in Phase 4

Phase 4 never writes canonical Program Element rows. The projection plan is
input to Phase 7, which performs governed writes under its own plan
(`docs/program-elements/rdte-phase-7-handoff.md`).
