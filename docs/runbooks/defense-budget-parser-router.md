# Defense-Budget Parser Router — Operator Runbook

This runbook contains the exact commands needed to set up, run, and
troubleshoot the Phase 3 cost-aware defense-budget parser router.

> **Safety invariant:** The default command path performs **no paid call**.
> Paid parsing requires both `--allow-paid-parse` and `--max-paid-pages N`.
> The router never writes canonical Program Element data.

---

## 1. Environment setup

### 1.1 Node / TypeScript side

```bash
# From the repository root
pnpm install
```

### 1.2 Python parser runtime

```bash
# From the repository root
cd apps/defense-budget-parser
uv sync --locked
```

For local development with all extras (Camelot, Docling, PaddleOCR, dev
tools):

```bash
cd apps/defense-budget-parser
uv sync --locked --extra camelot --extra docling --extra ocr --extra dev
```

---

## 2. Python runtime build (Docker)

Build each target separately. All commands are run from the repository root.

### 2.1 `table` target (pdfplumber + Camelot)

```bash
docker build \
  --target table \
  --platform linux/amd64 \
  -t capiro-defense-budget-parser:table \
  apps/defense-budget-parser
```

### 2.2 `layout` target (table + Docling CPU)

```bash
docker build \
  --target layout \
  --platform linux/amd64 \
  -t capiro-defense-budget-parser:layout \
  apps/defense-budget-parser
```

### 2.3 `ocr` target (layout + PaddleOCR CPU)

```bash
docker build \
  --target ocr \
  --platform linux/amd64 \
  -t capiro-defense-budget-parser:ocr \
  apps/defense-budget-parser
```

### 2.4 Verify the container entrypoint

```bash
docker run --rm capiro-defense-budget-parser:table version
```

---

## 3. Source / profile / plan commands

### 3.1 Validate the cycle manifest

```bash
pnpm --filter @capiro/api validate:defense-budget-manifest \
  --manifest path/to/cycle-manifest.json
```

### 3.2 Profile a source document

> **Note:** The operator script `profile-defense-budget-document.ts` is
> pending Workstream M. When available it will wrap the Python profiler with
> manifest-aware argument construction.

Direct Python runtime profiling (available now):

```bash
cd apps/defense-budget-parser

# Create a job envelope (see Section 7 of BUDGET-PARSER-ROUTER-V1.md)
cat > /tmp/profile-job.json <<'EOF'
{
  "schemaVersion": "defense_budget_parser_job_v1",
  "jobId": "profile-001",
  "sourcePath": "/absolute/path/to/source.pdf",
  "sourceSha256": "<sha256-of-source-file>",
  "engine": "deterministic_pdfplumber",
  "requestedPages": [1, 2, 3],
  "parserVersion": "0.1.0",
  "parserConfig": {},
  "parserConfigSha256": "<sha256-of-canonical-config>",
  "outputDirectory": "/tmp/parser-out",
  "includeDebugArtifacts": false
}
EOF

uv run capiro-defense-budget-parser profile \
  --job /tmp/profile-job.json \
  --out /tmp/profile-result.json
```

### 3.3 Build a parse plan

> **Note:** The operator script `plan-defense-budget-parse.ts` is pending
> Workstream M. When available it will produce a deterministic
> `defense_budget_parse_plan_v1` JSON file.

Plan construction is currently exercised through the unit tests:

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-3
```

---

## 4. Local extraction

> **Note:** The operator script `extract-defense-budget-cycle.ts` is pending
> Workstream M. When available it will orchestrate the full local-first
> extraction loop.

Direct Python runtime parsing (available now):

```bash
cd apps/defense-budget-parser

uv run capiro-defense-budget-parser run \
  --job /tmp/parse-job.json \
  --out /tmp/parse-result.json
```

---

## 5. Paid-page extraction

Paid parsing is disabled by default. To authorize a bounded paid run:

```bash
# Example shape once Workstream M operator scripts are available:
# pnpm --filter @capiro/api extract:defense-budget-cycle \
#   --manifest path/to/manifest.json \
#   --allow-paid-parse \
#   --max-paid-pages 10
```

Safety checks enforced by the router:

- `--allow-paid-parse` without `--max-paid-pages` is an error.
- `--max-paid-pages` must be a positive integer.
- Planned paid pages exceeding the cap produce a terminal plan with reason
  `paid_not_authorized` or `paid_page_cap_exceeded`.
- The LlamaParse executor refuses to run when `allowPaidParse` is false.

---

## 6. Artifact replay

> **Note:** The operator script `replay-defense-budget-parser-artifact.ts` is
> pending Workstream M. When available it will verify a cached artifact and
> replay it without re-paying parser costs.

Manual replay verification (available now):

```bash
# Recompute the content SHA of a cached result and compare with metadata.json
cd apps/defense-budget-parser
uv run python - <<'PY'
import json
from capiro_defense_budget_parser.canonical_json import sha256_canonical_json

with open('/path/to/artifact/result.json') as f:
    result = json.load(f)

recorded = result.pop('contentSha256')
# durationMillis is excluded from the content SHA for determinism
if 'metrics' in result and 'durationMillis' in result['metrics']:
    del result['metrics']['durationMillis']

recomputed = sha256_canonical_json(result)

print('recorded :', recorded)
print('recomputed:', recomputed)
print('match    :', recorded == recomputed)
PY
```

---

## 7. Verifier report interpretation

After local parsing and composition, the composed V1 artifact is passed to
Phase 2 verification in inspect mode.

```bash
pnpm --filter @capiro/api verify:defense-budget-artifact-v1 \
  --artifact path/to/extraction-artifact.json \
  --manifest path/to/cycle-manifest.json
```

Interpretation guide:

| Decision | Meaning | Router action |
|---|---|---|
| `PASS` | Artifact satisfies the verification policy | Continue to next document or terminal state `TERMINAL_PASSED` |
| `REVIEW` | Findings require human review but are parser-correctable | Escalation planner maps findings to pages and plans a stronger parser |
| `REJECT` | Artifact violates hard policy | Terminal state `TERMINAL_REJECTED`; no further parsing |

Parser-correctable finding codes are defined in
`apps/api/src/defense-budget/parser-router/escalation-planner.ts`
(`PARSER_CORRECTABLE_FINDING_CODES`).

---

## 8. Cache corruption recovery

The artifact store is content-addressed. A corrupted, missing, or unprovable
cached output is never reused.

Recovery steps:

1. Delete the corrupted artifact directory:

   ```bash
   rm -rf /path/to/artifact-store/<method>/<source-sha>/<config-sha>/<page-range>
   ```

2. Re-run the parser job for the affected pages. The router will recompute
   the source SHA, rebuild the identity tuple, and write a fresh artifact.

3. Verify the new artifact with the replay command in Section 6.

---

## 9. Parser runtime unavailable

Symptoms:

- `uv run capiro-defense-budget-parser …` exits with a non-zero code.
- Docker container fails to start or exits immediately.

Checks:

```bash
# 1. Confirm Python runtime dependencies are locked and synced
cd apps/defense-budget-parser
uv sync --locked

# 2. Run the CLI directly to see the error
uv run capiro-defense-budget-parser version

# 3. Validate a job envelope before submitting
uv run capiro-defense-budget-parser validate-job \
  --job /tmp/parse-job.json

# 4. Run the Python unit tests (no network required)
uv run pytest tests/ -v

# 5. Check Docker image build
docker build --target table --platform linux/amd64 \
  -t capiro-defense-budget-parser:table apps/defense-budget-parser
```

Common causes:

| Cause | Fix |
|---|---|
| Missing `uv.lock` or lock drift | `uv sync --locked` |
| Job JSON fails schema validation | `validate-job` output shows the exact field failure |
| Missing engine extras | Rebuild with the correct `--extra` flag or Docker target |
| Non-absolute `sourcePath` | Use an absolute path in the job envelope |
| `outputDirectory` not writable | Create the directory and ensure the runtime user can write to it |

---

## 10. Model-cache preparation

PaddleOCR and Docling download models on first use. To pre-warm the cache
inside the `ocr` container:

```bash
docker run --rm \
  -v capiro-parser-models:/home/parser/.paddleocr \
  capiro-defense-budget-parser:ocr \
  uv run python -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=True, lang='en')"
```

For Docling:

```bash
docker run --rm \
  capiro-defense-budget-parser:layout \
  uv run python -c "from docling.document_converter import DocumentConverter; DocumentConverter()"
```

---

## 11. No-network unit tests

### 11.1 TypeScript side

```bash
# Parser-router unit tests only (no network, no DB, no AWS)
pnpm --filter @capiro/api verify:pe-budget-phase-3
```

### 11.2 Python side

```bash
cd apps/defense-budget-parser
uv run pytest tests/ -v
```

All Python tests are designed to run without network access. Fixtures are
small synthetic PDFs generated in test setup or checked in under
`tests/fixtures/`.

---

## 12. Cleanup of local work directories

```bash
# Remove local parser output directories
rm -rf /tmp/parser-out /tmp/profile-out

# Remove local artifact store (only if you want to force re-parsing)
rm -rf /path/to/artifact-store

# Remove Python virtual environment and rebuild
cd apps/defense-budget-parser
rm -rf .venv
uv sync --locked

# Remove Docker images
docker rmi capiro-defense-budget-parser:table \
           capiro-defense-budget-parser:layout \
           capiro-defense-budget-parser:ocr
```

---

## 13. Useful verification commands

```bash
# Phase 1 contract verification
pnpm --filter @capiro/api verify:pe-budget-phase-1

# Phase 2 verifier verification
pnpm --filter @capiro/api verify:pe-budget-phase-2

# Phase 3 parser-router unit tests
pnpm --filter @capiro/api verify:pe-budget-phase-3

# Full API typecheck (includes parser-router tsconfig)
pnpm --filter @capiro/api typecheck
```
