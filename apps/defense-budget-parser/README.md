# capiro-defense-budget-parser

Isolated Python parser runtime for defense-budget PDF parsing.

This runtime owns **only** local parsing: page profiling, pdfplumber,
Camelot, Docling, and PaddleOCR. It must never:

- connect to Postgres
- access AWS credentials
- call LlamaParse
- write canonical data
- determine verification decisions
- select a winning parser result
- know tenant/client data

## Requirements

- Python 3.11
- [uv](https://docs.astral.sh/uv/) for dependency management

## Quick start

```bash
# Install dependencies
uv sync --locked

# Run tests
uv run pytest

# Run the parser
uv run capiro-defense-budget-parser run --job /work/job.json --out /work/result.json
```

## CLI commands

```bash
capiro-defense-budget-parser validate-job --job <job.json>
capiro-defense-budget-parser profile --job <job.json> --out <result.json>
capiro-defense-budget-parser run --job <job.json> --out <result.json>
capiro-defense-budget-parser version
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Contract/argument failure |
| 3 | Source SHA mismatch |
| 4 | Parser unavailable |
| 5 | Partial page failure |
| 6 | Total parser failure |

A partial page failure still writes a strict result artifact and exits 5.

## Engines

### pdfplumber (default)

Cheapest parser for clean digital PDFs. Table strategies: `lines`,
`lines_strict`, `text`, `hybrid`.

### Camelot

Second deterministic table parser for digital pages where pdfplumber
is insufficient. Flavors: `lattice`, `stream`, `network`, `hybrid`.

### PaddleOCR

PP-StructureV3 CPU mode for image-only/scanned/rotated pages. Formula
recognition, chart recognition, and document unwarping are disabled by
default.

### Docling

Mixed-layout CPU parsing for pages with narratives, headings, and
tables. (Requires `docling` extra.)

## Docker

Multi-target Dockerfile:

```bash
# table target (base + pdfplumber + Camelot)
docker build --target table -t capiro-parser-table .

# layout target (table + Docling CPU)
docker build --target layout -t capiro-parser-layout .

# ocr target (layout + PaddleOCR CPU)
docker build --target ocr -t capiro-parser-ocr .
```

All targets build for `linux/amd64`. No GPU required.

### Model downloads

Docling and PaddleOCR models are downloaded on first use. For unit
tests, mock model execution or use tiny synthetic fixtures — do not
download large models in ordinary unit tests.

PaddleOCR model cache: `PADDLE_OCR_MODEL_DIR` (default:
`/home/parser/.paddleocr`). Expected disk: ~500MB-2GB depending on
models. Expected RAM: ~1-4GB for CPU inference.

### Container smoke test

```bash
docker run --rm capiro-parser-ocr version
docker run --rm capiro-parser-table run --job /work/job.json --out /work/result.json
```

## Dependency groups

| Group | Contents |
|-------|----------|
| base | contracts, canonical JSON, profiling, pdfplumber |
| camelot | camelot-py, opencv-python-headless |
| docling | docling (CPU-only) |
| ocr | paddleocr, paddlepaddle |
| dev | pytest, ruff, mypy |

Only `opencv-python-headless` is used (not `opencv-python`) to avoid
conflicts.
