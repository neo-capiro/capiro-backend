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

# camelot imports cv2, which needs X/GL shared libraries absent from python:3.11-slim,
# and camelot shells out to ghostscript. Without these, "import camelot" raises
# ImportError: libxcb.so.1.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libxcb1 libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 libgomp1 ghostscript \
 && rm -rf /var/lib/apt/lists/*

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
RUN uv sync --locked --no-dev --extra camelot

# ── table target: base + pdfplumber + Camelot ───────────────────────

FROM base AS table

USER root
RUN uv sync --locked --no-dev --extra camelot

RUN chown -R parser:parser /app/.venv
USER parser
ENTRYPOINT ["uv", "run", "capiro-defense-budget-parser"]
CMD ["version"]

# ── layout target: table + Docling CPU ──────────────────────────────

FROM table AS layout

USER root
RUN uv sync --locked --no-dev --extra camelot --extra docling

RUN chown -R parser:parser /app/.venv
USER parser
ENTRYPOINT ["uv", "run", "capiro-defense-budget-parser"]
CMD ["version"]

# ── ocr target: layout + PaddleOCR CPU ──────────────────────────────

FROM layout AS ocr

USER root
RUN uv sync --locked --no-dev --extra camelot --extra docling --extra ocr

# PaddleOCR model cache directory
ENV PADDLE_OCR_MODEL_DIR=/home/parser/.paddleocr
RUN mkdir -p /home/parser/.paddleocr && chown parser:parser /home/parser/.paddleocr

RUN chown -R parser:parser /app/.venv
USER parser
ENTRYPOINT ["uv", "run", "capiro-defense-budget-parser"]
CMD ["version"]
