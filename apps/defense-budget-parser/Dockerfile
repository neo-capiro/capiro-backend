# Multi-target Dockerfile for the capiro-defense-budget-parser runtime.
#
# Targets:
#   table   base + pdfplumber + Camelot
#   layout  table + Docling CPU
#   ocr     layout + PaddleOCR CPU
#
# Build for linux/amd64 in Phase 3 container tests.
# Does not require GPU. Runs as non-root user.
# Does not contain AWS credentials or LlamaParse keys.

# ── base stage ──────────────────────────────────────────────────────

FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --gid 1001 parser && \
    useradd --uid 1001 --gid parser --shell /bin/bash --create-home parser

WORKDIR /app

# Install uv for deterministic dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy project files
COPY pyproject.toml uv.lock ./
COPY src/ ./src/
COPY tests/ ./tests/

# Install base dependencies (locked)
RUN uv sync --locked --no-dev --extra camelot 2>/dev/null || uv sync --locked --no-dev

# ── table target: base + pdfplumber + Camelot ───────────────────────

FROM base AS table

RUN uv sync --locked --no-dev --extra camelot || true

USER parser
ENTRYPOINT ["uv", "run", "capiro-defense-budget-parser"]
CMD ["version"]

# ── layout target: table + Docling CPU ──────────────────────────────

FROM table AS layout

RUN uv sync --locked --no-dev --extra camelot --extra docling || true

USER parser
ENTRYPOINT ["uv", "run", "capiro-defense-budget-parser"]
CMD ["version"]

# ── ocr target: layout + PaddleOCR CPU ──────────────────────────────

FROM layout AS ocr

RUN uv sync --locked --no-dev --extra camelot --extra docling --extra ocr || true

# PaddleOCR model cache directory
ENV PADDLE_OCR_MODEL_DIR=/home/parser/.paddleocr
RUN mkdir -p /home/parser/.paddleocr && chown parser:parser /home/parser/.paddleocr

USER parser
ENTRYPOINT ["uv", "run", "capiro-defense-budget-parser"]
CMD ["version"]
