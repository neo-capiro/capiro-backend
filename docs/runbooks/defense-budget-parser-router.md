# Defense-Budget Parser Router — Operator Runbook

This runbook operates the Phase 3 local-first parser router. It performs no
canonical Program Element write. The default workflow makes no database, AWS,
or paid parser call.

## 1. Environment setup

```bash
# Repository root
pnpm install

cd apps/defense-budget-parser
uv sync --locked --all-groups
uv run capiro-defense-budget-parser version --json
```

The version output must list exact identities for:

```text
deterministic_pdfplumber
camelot
docling
paddleocr
```

Use the runtime image that contains the engine required by the route plan.
Reporting an engine version does not imply that its optional package/model is
available in the current image; execution fails with exit `4` when it is not.

## 2. Container targets

```bash
# Repository root
docker build --platform linux/amd64 --target table \
  -f apps/defense-budget-parser/Dockerfile .

docker build --platform linux/amd64 --target layout \
  -f apps/defense-budget-parser/Dockerfile .

docker build --platform linux/amd64 --target ocr \
  -f apps/defense-budget-parser/Dockerfile .
```

- `table`: pdfplumber and Camelot.
- `layout`: table target plus Docling CPU.
- `ocr`: layout target plus PaddleOCR CPU.

The API image is intentionally unchanged and contains no Python or parser-ML
packages.

## 3. Prepare a manual manifest and source files

Phase 3 performs no source discovery. Supply:

- one strict `defense_budget_cycle_manifest_v1` file;
- one local source PDF per selected document;
- a SourceDocument UUID only when persisting final verification audit;
- an explicit Phase 1 V1 companion for `native_structured` documents.

Validate the manifest:

```bash
pnpm --filter @capiro/api validate:defense-budget-manifest -- \
  --input manifest.json
```

## 4. Profile a supplied PDF

```bash
pnpm --filter @capiro/api profile:defense-budget-document -- \
  --manifest manifest.json \
  --document r1-army-fy2027 \
  --source sources/r1-army.pdf \
  --out work/r1-army/profile.json
```

The command:

1. recomputes source SHA-256;
2. validates the manifest/document;
3. profiles every physical page with pdfplumber only;
4. writes a strict, content-addressed profile;
5. refuses overwrite unless `--force` is supplied.

No OCR, Docling, PaddleOCR, LlamaParse, database, or AWS operation occurs.

## 5. Create a deterministic local plan

```bash
pnpm --filter @capiro/api plan:defense-budget-parse -- \
  --manifest manifest.json \
  --document r1-army-fy2027 \
  --source sources/r1-army.pdf \
  --profile work/r1-army/profile.json \
  --out work/r1-army/plan.json
```

The profile source SHA must equal the actual supplied source SHA. Repeating the
command with identical inputs produces a byte-identical plan and execution ID.
The initial plan is always local and free.

A `native_structured` document is rejected by this PDF plan command; use the
companion workflow in Section 8.

## 6. Run local extraction and Phase 2 inspect verification

```bash
pnpm --filter @capiro/api extract:defense-budget-cycle -- \
  --manifest manifest.json \
  --document r1-army-fy2027 \
  --source sources/r1-army.pdf \
  --work-dir work/fy2027 \
  --out work/fy2027/r1-army.extraction-v1.json
```

Default behavior:

- profiles every page;
- builds the deterministic local plan;
- executes or cryptographically replays local parser runs;
- composes one selected result or explicit failure per requested page;
- builds a strict `defense_budget_extraction_v1` artifact;
- calls Phase 2 in inspect mode;
- maps parser-correctable findings to exact evidence pages;
- executes stronger local engines when needed;
- stops before a paid call unless authorization is present;
- writes `execution-report.json` under the document work directory.

A generic page-level artifact may truthfully end in `NEEDS_REVIEW` until a
registered family-specific extraction adapter produces budget assertions. That
is not an execution failure and must not be converted to a pass.

## 7. Explicit paid-page escalation

```bash
export LLAMAPARSE_API_KEY='...'
export LLAMAPARSE_BASE_URL='https://api.cloud.llamaindex.ai/api/parsing'

pnpm --filter @capiro/api extract:defense-budget-cycle -- \
  --manifest manifest.json \
  --document r2-army-fy2027 \
  --source sources/r2-army.pdf \
  --work-dir work/fy2027 \
  --out work/fy2027/r2-army.extraction-v1.json \
  --allow-paid-parse \
  --max-paid-pages 12 \
  --paid-mode pdf_premium
```

Paid rules:

- both authorization and a positive page cap are mandatory;
- only unresolved, explicitly mapped pages are submitted;
- one-based pages are converted to provider zero-based pages exactly once;
- the provider is not automatically retried as a new job;
- a proven cached output consumes no paid-page allowance;
- a corrupt cache never silently authorizes a new paid call;
- local output does not lose solely because a paid engine also returned output.

## 8. Native-structured companion workflow

First convert the structured companion through the Phase 1 contract. Then run:

```bash
pnpm --filter @capiro/api extract:defense-budget-cycle -- \
  --manifest manifest.json \
  --document r1-structured-fy2027 \
  --source sources/r1-official.pdf \
  --structured-companion companions/r1.extraction-v1.json \
  --work-dir work/fy2027 \
  --out work/fy2027/r1.extraction-v1.json
```

The companion must:

- be schema-valid and semantically valid under Phase 1;
- match manifest document identity and source PDF SHA;
- contain `native_structured` parser lineage;
- use the supplied SourceDocument ID when persisted.

The command does not parse the PDF for primary values. It sends the companion
through the same Phase 2 verifier.

For `--all-documents`, supply:

```text
--source-root <PDF directory>
--structured-companion-root <V1 companion directory>
```

Each native companion is resolved as:

```text
<root>/<manifest-document-key>.extraction-v1.json
```

## 9. Persist final verification audit

Persist only after SourceDocument registration and parser-proof storage are
configured.

```bash
export DATABASE_URL='...'
export BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT='/shared/parser-artifacts'

pnpm --filter @capiro/api extract:defense-budget-cycle -- \
  --manifest manifest.json \
  --document r1-army-fy2027 \
  --source sources/r1-army.pdf \
  --source-document-id '<uuid>' \
  --work-dir work/fy2027 \
  --out work/fy2027/r1-army.extraction-v1.json \
  --persist-verification-audit
```

The shared parser-artifact root must be readable by the verification process.
The same Prisma client records `DocumentParseJob` and Phase 2 audit rows.

### Persisted paid output

Also configure:

```bash
export BUDGET_VERIFICATION_LLAMAPARSE_OUTPUT_BUCKET='capiro-parser-output'
export BUDGET_PARSER_ARTIFACT_S3_PREFIX='derived/public/dod-budget/parser_runs'
export AWS_REGION='us-east-1'
```

For a local S3-compatible rehearsal only:

```bash
export BUDGET_VERIFICATION_S3_ENDPOINT='http://127.0.0.1:4566'
```

Normalized LlamaParse results are written to versioned S3. Replay requires the
exact VersionId. Before the parse-job row is written, the recorder re-reads the
persisted object and recomputes its actual byte SHA.

Do not use audit persistence against a shared environment without separate
operational authorization.

## 10. Replay parser artifacts

Local descriptor:

```bash
pnpm --filter @capiro/api replay:defense-budget-parser-artifact -- \
  --descriptor work/fy2027/parser-artifacts/.../metadata.json
```

The command revalidates descriptor identity, byte SHA, content SHA, source SHA,
method, version, configuration SHA, and exact requested pages. It makes no
parser call.

S3 replay must use the injected `S3ParserArtifactStore`; the local replay CLI
refuses to silently discover AWS credentials.

## 11. Interpret terminal results

| Exit | Meaning |
|---:|---|
| 0 | Phase 2 verification passed |
| 2 | argument, manifest, or contract failure |
| 3 | source, artifact, manifest, or proof failure |
| 4 | parser runtime/engine unavailable |
| 5 | parsing incomplete |
| 6 | Phase 2 rejected |
| 7 | Phase 2 needs review |
| 8 | paid-page cap exceeded |
| 9 | internal failure |

The execution report contains:

- parser rounds and plan SHAs;
- exact parser-run IDs;
- executed and reused pages by engine;
- paid pages and provider credits when returned;
- parser failures;
- artifact ID, content SHA, byte SHA, and locator;
- verifier decision;
- unresolved and review-required findings;
- the next operator action.

## 12. Cache corruption recovery

A corrupt output is never reused. Preserve it for diagnosis, then remove or
quarantine the affected result and descriptor under the exact identity path.
Re-run the same command. A local engine may execute again. A paid engine still
requires explicit authorization and cap.

Never edit a descriptor to make it match mutated bytes.

## 13. Runtime unavailable

Confirm:

```bash
cd apps/defense-budget-parser
uv sync --locked --all-groups
uv run capiro-defense-budget-parser version --json
```

Use the correct Docker target for Docling or PaddleOCR. The runtime reports
exit `4` when an optional engine/package/model is unavailable.

## 14. Validation and closeout

Without container builds:

```bash
pnpm --dir apps/api exec tsx scripts/verify-pe-budget-phase-3-closeout.ts
```

Including all three Linux/amd64 Docker targets:

```bash
pnpm --dir apps/api exec tsx scripts/verify-pe-budget-phase-3-closeout.ts \
  --include-containers
```

The closeout runner executes:

- Phase 1, Phase 2, and Phase 3 regression suites;
- strict Phase 3 TypeScript;
- Prisma validation;
- architecture containment;
- TypeScript/Python cross-language contract and canonical-hash checks;
- locked Python sync, tests, Ruff, and mypy;
- all 20 real mutate–fail–restore negative controls;
- Prettier;
- optional table/layout/OCR container builds.

GitHub Actions are not required for Phase 3 acceptance.

## 15. Cleanup

Work directories contain source-adjacent parser results and audit reports. Clean
only after the final artifact, parser descriptors, and execution reports have
been retained according to the operator’s storage policy.

```bash
rm -rf work/fy2027
```

Do not delete shared parser artifacts or persisted proof objects referenced by a
Phase 2 audit run.
