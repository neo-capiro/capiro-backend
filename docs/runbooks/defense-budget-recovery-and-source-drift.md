# Defense Budget Phase 6 Recovery and Source-Drift Runbook

## When to use this runbook

Use this procedure when a congressional/public-law source URL changes, an archived PDF hash differs, a SourceDocument has been superseded, a parser output was built from the wrong bytes, or an operator suspects stale proof.

## Non-negotiable rule

Do not repair source drift by editing a verified projection in place. Phase 6 proof/provenance fields are immutable. New source bytes require a new SourceDocument/proof chain and a superseding projection/certification.

## 1. Stop promotion

Phase 6 itself has no canonical promotion path. If a later environment has enabled Phase 7, disable the affected stage from promotion until recovery is complete.

## 2. Identify the logical source

Record:

- manifest document key;
- fiscal year;
- track/stage;
- expected URL and actual URL;
- expected SHA-256 and actual SHA-256;
- current SourceDocument ID/status;
- source-profile hash;
- artifact ID/content hash;
- verification run/candidate IDs.

A SHA mismatch, URL drift for the same logical key, or superseded SourceDocument used as current is a failure.

## 3. Re-archive and re-prove the source

Archive the newly approved source through the existing source-document/archive process. Never reuse the old SHA or SourceDocument ID for different bytes.

If a companion document changed independently, update only that companion proof. Public-law and line-detail sources remain independently hashed. For enactment recovery follow `defense-budget-enactment-proof-v1.md`.

## 4. Re-extract deterministically

Use the governed Phase 6 stage entrypoint, which delegates to the Phase 3 parser/router:

```bash
pnpm --filter @capiro/api phase6:extract-stage -- \
  --manifest <manifest.json> \
  --document <document-key> \
  --source <approved-source.pdf> \
  --work-dir <work-dir> \
  --out <artifact.json>
```

Preserve omitted pages, unresolved rows, warnings, parser-run identity, and page/cell evidence. Do not widen title matching to make recovery pass.

Paid parsing is only available through the governed parser router and requires explicit `--allow-paid-parse --max-paid-pages <N>`. Direct paid-provider calls from Phase 6 modules are prohibited.

## 5. Re-run stage verification

Verify field ownership, exact native identity, evidence, source/profile binding, arithmetic when source-defined, and required cross-stage comparisons.

Failure semantics:

- missing comparison → `NOT_RUN`, never zero;
- candidate/unresolved identity → review/block, never accepted position;
- stale/superseded source → blocking;
- conflicting duplicate → blocking;
- missing enactment incorporation proof → blocking;
- different execution metric → separate fact/profile, never reinterpretation.

## 6. Supersede audit projections

If optional Phase 6 audit persistence is being used, insert the newly verified projection with a new idempotency/proof identity and mark the old projection `superseded`. Do not mutate immutable proof fields on the old row and do not delete the old projection.

The partial unique index permits only one live candidate/verified projection per natural key.

## 7. Re-certify the annual cycle

```bash
pnpm --filter @capiro/api phase6:verify-cycle -- --input <recovered-cycle-input.json>
pnpm --filter @capiro/api phase6:report-cycle -- --input <recovered-cycle-input.json>
```

The new certification must carry a new deterministic content hash if any proof-bearing input changed.

## 8. Run full closeout

From `apps/api`:

```bash
bash scripts/verify-pe-budget-phase6-closeout.sh
```

Do not declare recovery complete if the 24 source-mutation controls, projection Prisma generate/validate, strict TypeScript, Jest, Ruff/mypy/Pytest, architecture scans, or disposable PostgreSQL rehearsal fail.

## Recovery scenarios

### Same logical document, new URL, identical bytes

Treat the URL change as source drift requiring operator review. Preserve the byte hash but do not silently rewrite the old source locator in a verified proof chain.

### Same logical document, changed bytes

Create a new SourceDocument/proof. Re-extract and reverify. Supersede prior projections/certification.

### Source was superseded accidentally

Do not mark it current by editing proof JSON. Resolve the correct current SourceDocument through the source registry and rebuild proof-bound outputs.

### Public law unchanged, explanatory statement changed

Keep public-law proof hash unchanged; replace the companion line-detail proof only after incorporation is independently reconfirmed and the exact public-law reference still passes trusted verification.

### Parser output source hash differs from source proof

Reject the parser result. Re-run against the exact approved source bytes.

### Paid verifier cap exceeded

Stop the run and route to human review or a lower-cost deterministic recovery path. Never raise the cap ad hoc inside a stage extractor.

## Recovery completion evidence

Recovery is complete only when the new source/proof chain is current, all relevant verification checks are green or explicitly review-resolved, the cycle certification is reproducible, the old projection is superseded rather than mutated, all permanent Phase 6 gates pass, and the repository is clean.
