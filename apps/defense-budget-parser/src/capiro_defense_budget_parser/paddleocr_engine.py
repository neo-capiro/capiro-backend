"""capiro_defense_budget_parser.paddleocr_engine — plain PaddleOCR (detection +
recognition) targeted OCR engine, with deterministic geometric row/column
reconstruction.

Parse only pages that require OCR/layout recovery. Uses PaddleOCR's ordinary
text-detection-and-recognition pipeline in CPU mode -- NOT PP-Structure.

Phase 10B-23B: PP-Structure's bundled SLANet table-structure model was proven,
across both linux/arm64 and linux/amd64 and across paddlepaddle 2.6.2-3.3.1,
to misassign real dollar values to the wrong Program Element row whenever it
processes genuine multi-row table content (row 5's cell showed PE 0601121A's
value under PE 0601601A's row -- a deterministic, architecture-independent
model defect, not a crash). Bumping paddlepaddle to 3.1.x/3.2.x separately
fixes an unrelated construction-time crash in that same model, but does not
fix the misalignment. Neither combination is safe to ship. This engine
therefore never constructs PP-Structure, SLANet, or the layout/formula
sub-models at all: it runs plain detection+recognition against a
`pypdfium2`-rendered page image, then reconstructs rows and columns
deterministically from token bounding boxes -- geometry, not a heuristic
correction of uncertain OCR text. Token-level text accuracy was independently
verified exact against five known Program Element dollar values before this
reconstruction step was trusted. See the Phase 10B-23B PR description for the
full bake-off (accuracy matrix, model checksums, timings, both
architectures).

This engine must never:
- connect to Postgres
- access AWS credentials
- call LlamaParse
- write canonical data
- determine verification decisions
- select a winning parser result
- know tenant/client data
- coerce OCR text to numeric money
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Literal, cast

from .contracts import (
    BoundingBoxV1,
    LayoutBlockV1,
    ParsedImageRegionV1,
    ParsedTableCellV1,
    ParsedTableV1,
    ParserPageFailureV1,
    ParserPageResultV1,
    ParserRuntimeMetricsV1,
    ParserRuntimeResultV1,
    ParserRuntimeWarningV1,
    compute_parser_config_sha256,
    compute_result_content_sha256,
)
from .pdf_profile import (
    compute_file_sha256,
    verify_source_sha256,
)

# ------------------------------------------------------------------ #
# Engine identity
# ------------------------------------------------------------------ #

ENGINE_NAME = 'paddleocr'
ENGINE_VERSION = 'paddleocr-det-rec-row-reconstruction-v1'

# ------------------------------------------------------------------ #
# Default configuration
# ------------------------------------------------------------------ #

DEFAULT_PADDLEOCR_CONFIG: dict[str, Any] = {
    'dpi': 200,
    'cpuMode': True,
    'maxPagesPerJob': 50,
    'perPageTimeoutSeconds': 120,
    'parallelProcessing': False,
    'use_gpu': False,
    # Phase 10B-23A/B: MKLDNN is unavailable in the tested ARM64 paddlepaddine
    # build -- `config.set_mkldnn_cache_capacity` does not exist on that
    # build's `AnalysisConfig`, raising an uncaught AttributeError during
    # predictor construction (confirmed empirically, not architecture-neutral
    # theorizing). MKLDNN is an x86-oriented acceleration backend with no
    # ARM64 upside even when present, so the safe default is off everywhere
    # rather than branching by architecture.
    'enable_mkldnn': False,
    # Row/column reconstruction thresholds (Phase 10B-23B). A new row starts
    # when a token's vertical center is more than `rowGapRatio` times the
    # running median token height away from the previous token's center.
    # Column bands are formed the same way along the horizontal axis, but
    # only over tokens that belong to a row with 2+ tokens -- single-token
    # rows are prose (titles, footnotes), not table data, and must not
    # contribute to column-band geometry.
    'rowGapRatio': 0.6,
    'columnGapRatio': 1.5,
}


def get_default_config() -> dict[str, Any]:
    """Return a copy of the default PaddleOCR config."""
    return dict(DEFAULT_PADDLEOCR_CONFIG)


def compute_config_sha256(config: dict[str, Any]) -> str:
    """Compute the canonical config SHA-256."""
    return compute_parser_config_sha256(config)


# ------------------------------------------------------------------ #
# Config validation
# ------------------------------------------------------------------ #


def validate_config(config: dict[str, Any]) -> list[str]:
    """Validate the PaddleOCR config and return a list of warnings (empty if OK)."""
    warnings: list[str] = []

    if config.get('dpi', 200) < 72:
        warnings.append('dpi below 72 may produce poor OCR results')
    if config.get('dpi', 200) > 600:
        warnings.append('dpi above 600 may cause excessive memory usage')

    max_pages = config.get('maxPagesPerJob', 50)
    if not isinstance(max_pages, int) or max_pages < 1:
        warnings.append('maxPagesPerJob must be a positive integer')

    timeout = config.get('perPageTimeoutSeconds', 120)
    if not isinstance(timeout, (int, float)) or timeout < 1:
        warnings.append('perPageTimeoutSeconds must be >= 1')

    if config.get('use_gpu', False):
        warnings.append('GPU mode is not supported in Phase 3; forcing CPU')

    row_gap_ratio = config.get('rowGapRatio', 0.6)
    if not isinstance(row_gap_ratio, (int, float)) or row_gap_ratio <= 0:
        warnings.append('rowGapRatio must be a positive number')

    column_gap_ratio = config.get('columnGapRatio', 1.5)
    if not isinstance(column_gap_ratio, (int, float)) or column_gap_ratio <= 0:
        warnings.append('columnGapRatio must be a positive number')

    return warnings


# ------------------------------------------------------------------ #
# Page rendering
# ------------------------------------------------------------------ #


def render_page_to_image(
    pdf_path: str | Path,
    page_number: int,
    dpi: int = 200,
) -> Any:
    """Render a single PDF page to a PIL Image at the specified DPI.

    Uses `pypdfium2` (Google's PDFium, Apache-2.0/BSD-3-Clause) exclusively.
    PyMuPDF was deliberately not used here: it is AGPL-3.0/commercial
    dual-licensed, an unfavorable fit alongside PaddleOCR/PaddlePaddle's own
    Apache-2.0 posture. `pypdfium2` needs no external system binary (unlike
    `pdf2image`, which shells out to poppler-utils).
    """
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        if page_number < 1 or page_number > len(pdf):
            raise ValueError(f'page {page_number} out of range (1-{len(pdf)})')
        page = pdf[page_number - 1]
        try:
            bitmap = page.render(scale=dpi / 72.0)
            pil_image = bitmap.to_pil().convert('RGB')
        finally:
            page.close()
        return pil_image
    finally:
        pdf.close()


# ------------------------------------------------------------------ #
# PaddleOCR (plain detection + recognition) invocation
# ------------------------------------------------------------------ #


def _create_paddle_ocr(config: dict[str, Any]) -> Any:
    """Create a plain `PaddleOCR` (detection + recognition) instance.

    Deliberately never constructs `PPStructure`/`PPStructureV3` -- see the
    module docstring for why. Lazily imported so this module can be loaded
    without PaddleOCR installed (e.g. for config/validation tests).
    """
    try:
        from paddleocr import PaddleOCR
    except ImportError as e:
        raise RuntimeError(
            'PaddleOCR is not installed. Install with: pip install paddleocr paddlepaddle'
        ) from e

    engine_kwargs: dict[str, Any] = {
        'use_gpu': False,
        'use_angle_cls': False,
        'show_log': False,
        # 'ch' (not 'en'): this is the model set actually baked into the
        # image (see the Dockerfile's bake_model calls). PP-OCRv4's 'ch'
        # detection/recognition models handle English + digits correctly --
        # confirmed exact against known dollar-value ground truth -- so
        # there is no reason to add a second, separately-baked 'en' model
        # set.
        'lang': 'ch',
    }
    if config.get('enable_mkldnn', False):
        engine_kwargs['enable_mkldnn'] = True

    return PaddleOCR(**engine_kwargs)


def _looks_like_ocr_line(entry: Any) -> bool:
    """True for a single `[bbox_4_points, (text, confidence)]` OCR line.

    Deliberately strict (a 4-point bbox, a str text candidate) rather than
    just "a 2-element list": a nested `[[line, line]]` wrapper with exactly
    two lines would otherwise itself structurally resemble one line (its
    outer list has length 2, and each inner line is itself a list),
    misdetecting the wrapping shape for exactly-two-line pages.
    """
    if not (isinstance(entry, (list, tuple)) and len(entry) == 2):
        return False
    bbox_candidate, text_candidate = entry
    if not (isinstance(bbox_candidate, list) and len(bbox_candidate) == 4):
        return False
    if not all(isinstance(point, (list, tuple)) and len(point) == 2 for point in bbox_candidate):
        return False
    return (
        isinstance(text_candidate, (list, tuple))
        and len(text_candidate) == 2
        and isinstance(text_candidate[0], str)
    )


def _extract_tokens(raw_result: Any) -> list[dict[str, Any]]:
    """Normalize `PaddleOCR.ocr()` output into a flat token list.

    The exact return shape has varied across paddleocr releases (a bare list
    of lines, vs. a list of one list-of-lines per input image). Handle both
    rather than assuming one.
    """
    if not raw_result:
        return []

    if raw_result and _looks_like_ocr_line(raw_result[0]):
        lines = raw_result
    elif (
        raw_result
        and isinstance(raw_result[0], list)
        and raw_result[0]
        and _looks_like_ocr_line(raw_result[0][0])
    ):
        lines = raw_result[0]
    else:
        lines = raw_result[0] if raw_result and raw_result[0] else []

    tokens: list[dict[str, Any]] = []
    for entry in lines:
        if not entry:
            continue
        bbox_pts, (text, confidence) = entry
        xs = [p[0] for p in bbox_pts]
        ys = [p[1] for p in bbox_pts]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        tokens.append(
            {
                'text': text,
                'confidence': float(confidence),
                'x0': x0,
                'y0': y0,
                'x1': x1,
                'y1': y1,
                'center_x': (x0 + x1) / 2.0,
                'center_y': (y0 + y1) / 2.0,
                'height': y1 - y0,
            }
        )
    return tokens


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _cluster_rows(
    tokens: list[dict[str, Any]],
    row_gap_ratio: float,
) -> list[list[dict[str, Any]]]:
    """Group tokens into rows by vertical proximity, left-to-right within a row."""
    if not tokens:
        return []
    median_height = _median([t['height'] for t in tokens if t['height'] > 0]) or 15.0
    gap_threshold = row_gap_ratio * median_height

    ordered = sorted(tokens, key=lambda t: t['center_y'])
    rows: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    last_y: float | None = None
    for token in ordered:
        if last_y is None or (token['center_y'] - last_y) <= gap_threshold:
            current.append(token)
        else:
            rows.append(current)
            current = [token]
        last_y = token['center_y']
    if current:
        rows.append(current)

    for row in rows:
        row.sort(key=lambda t: t['center_x'])
    return rows


def _cluster_columns(
    rows: list[list[dict[str, Any]]],
    column_gap_ratio: float,
) -> tuple[list[float], int]:
    """Build stable, page-wide column bands from multi-token (tabular) rows only.

    Single-token rows are prose (titles, headers, footnotes) and must not
    widen or shift the column geometry. Returns (sorted column boundary
    centers, column count) -- each table token is later assigned to the
    nearest boundary, so a row that omits one column (a real, valid pattern
    in these documents -- some PEs have no FY2022 Actuals figure at all)
    keeps its remaining values under their correct columns instead of
    shifting left.
    """
    tabular_tokens = [t for row in rows if len(row) >= 2 for t in row]
    if not tabular_tokens:
        return [], 0

    median_width = _median([t['x1'] - t['x0'] for t in tabular_tokens]) or 40.0
    gap_threshold = column_gap_ratio * median_width

    ordered = sorted(t['center_x'] for t in tabular_tokens)
    bands: list[list[float]] = [[ordered[0]]]
    for x in ordered[1:]:
        if (x - bands[-1][-1]) <= gap_threshold:
            bands[-1].append(x)
        else:
            bands.append([x])

    centers = [sum(band) / len(band) for band in bands]
    return centers, len(centers)


def _nearest_column_index(center_x: float, column_centers: list[float]) -> int:
    best_index = 0
    best_distance = float('inf')
    for index, column_center in enumerate(column_centers):
        distance = abs(center_x - column_center)
        if distance < best_distance:
            best_distance = distance
            best_index = index
    return best_index


# ------------------------------------------------------------------ #
# Funding-column semantics (Phase 10B-23C2)
# ------------------------------------------------------------------ #

# A funding cell is a token whose text is a dollar figure: digits with
# thousands separators, an optional decimal, optional surrounding
# parentheses (negative), or a bare integer amount. Deliberately NOT
# matched: bare 1-2 digit codes like "07" (budget-activity numbers),
# "U"/"C" (classification letters), "999999999" style line-number runs
# without a comma-grouped form, years ("2024"), and "Mar 2023" fragments.
_FUNDING_VALUE_RE = re.compile(
    r'^\(?\$?\d{1,3}(,\d{3})+(\.\d+)?\)?$|^\(?\$?\d+\.\d+\)?$'
)


def is_funding_value_text(text: str) -> bool:
    """True when a token's text can be a dollar amount in these exhibits.

    Groups of 2+ comma-separated digits, or a decimal amount. A bare
    short integer (the budget-activity "07", a line number "223") does
    NOT qualify: on the scanned Exhibit R-1 pages the budget-activity
    column sits immediately left of the value column, and treating it
    as money silently satisfies "every PE row has a value" when the
    real FY2024 cell is blank.
    """
    if not text:
        return False
    stripped = text.strip().replace('$', '')
    if not _FUNDING_VALUE_RE.fullmatch(stripped):
        return False
    digits = stripped.replace(',', '').replace('.', '').strip('()')
    # Bare integers of 1-3 digits are codes/line numbers here, not
    # thousands-of-dollars amounts; comma-grouped or decimal amounts
    # always qualify regardless of magnitude.
    if ',' not in stripped and '.' not in stripped and len(digits) <= 3:
        return False
    return True


def find_pe_funding_association(
    cells: list[dict[str, Any]],
) -> str | None:
    """Return the text of the rightmost funding-value cell in a row, or None.

    A row qualifies as a Program-Element funding row only when it carries
    BOTH a PE code and an actual funding value under this definition.
    Budget-activity codes and line numbers never satisfy the funding
    association.
    """
    funding = [c['text'] for c in cells if is_funding_value_text(c['text'])]
    return funding[-1] if funding else None


def _bbox_to_v1(x0: float, y0: float, x1: float, y1: float) -> BoundingBoxV1:
    return BoundingBoxV1(x0=str(x0), y0=str(y0), x1=str(x1), y1=str(y1))


def reconstruct_page_structure(
    tokens: list[dict[str, Any]],
    row_gap_ratio: float,
    column_gap_ratio: float,
) -> tuple[list[LayoutBlockV1], list[ParsedTableV1], str | None]:
    """Deterministically reconstruct blocks + at most one table from tokens.

    A row with a single token is prose (kept as a `LayoutBlockV1` paragraph,
    in reading order). A row with 2+ tokens is a table row; all such rows on
    the page are collected into one `ParsedTableV1` with a page-wide,
    gap-clustered column geometry (see `_cluster_columns`) so column
    identity stays stable across rows that omit a cell.
    """
    rows = _cluster_rows(tokens, row_gap_ratio)
    column_centers, _column_count = _cluster_columns(rows, column_gap_ratio)

    blocks: list[LayoutBlockV1] = []
    table_cells: list[ParsedTableCellV1] = []
    text_parts: list[str] = []
    block_index = 0
    table_row_index = 0
    max_column_index = -1
    table_x0 = table_y0 = float('inf')
    table_x1 = table_y1 = float('-inf')

    for row in rows:
        row_text = ' '.join(t['text'] for t in row if t['text'])
        if row_text:
            text_parts.append(row_text)

        if len(row) < 2:
            if row:
                token = row[0]
                blocks.append(
                    LayoutBlockV1(
                        blockIndex=block_index,
                        blockType='paragraph',
                        text=token['text'],
                        readingOrder=block_index,
                        boundingBox=_bbox_to_v1(token['x0'], token['y0'], token['x1'], token['y1']),
                    )
                )
                block_index += 1
            continue

        for token in row:
            column_index = _nearest_column_index(token['center_x'], column_centers)
            max_column_index = max(max_column_index, column_index)
            table_cells.append(
                ParsedTableCellV1(
                    rowIndex=table_row_index,
                    columnIndex=column_index,
                    text=token['text'],
                    boundingBox=_bbox_to_v1(token['x0'], token['y0'], token['x1'], token['y1']),
                    confidence=str(token['confidence']),
                )
            )
            table_x0 = min(table_x0, token['x0'])
            table_y0 = min(table_y0, token['y0'])
            table_x1 = max(table_x1, token['x1'])
            table_y1 = max(table_y1, token['y1'])
        table_row_index += 1

    # Table-level boundingBox (the union of every cell's box) is REQUIRED,
    # not optional, by the TS-side Zod contract (parser-runtime-contract-v1.ts:
    # `.optional()`, not `.nullish()` -- an explicit JSON `null` fails
    # validation where an omitted key would not). This was a pre-existing gap
    # in the PP-Structure-based engine this replaces; it was never caught
    # because that engine's own SLANet table crash meant no paddleocr table
    # ever reached this validation in the real 170-page production path.
    tables: list[ParsedTableV1] = []
    if table_cells:
        tables.append(
            ParsedTableV1(
                tableIndex=0,
                label=None,
                rowCount=table_row_index,
                columnCount=max_column_index + 1,
                cells=table_cells,
                boundingBox=_bbox_to_v1(table_x0, table_y0, table_x1, table_y1),
                warnings=[],
            )
        )

    full_text = '\n'.join(text_parts) if text_parts else None
    return blocks, tables, full_text


def process_page_with_paddleocr(
    engine: Any,
    img: Any,
    page_number: int,
    config: dict[str, Any],
    page_width: float | None = None,
    page_height: float | None = None,
    rotation: int = 0,
) -> ParserPageResultV1:
    """Process a single rendered page image with plain PaddleOCR det+rec,
    then reconstruct rows/columns deterministically from token geometry.
    """
    warnings: list[str] = []

    try:
        import numpy as np

        np_bgr = np.array(img)[:, :, ::-1].copy()
        raw_result = engine.ocr(np_bgr, cls=False)
    except Exception as e:
        warnings.append(f'PaddleOCR processing error: {e}')
        raw_result = None

    tokens = _extract_tokens(raw_result)
    blocks, tables, full_text = reconstruct_page_structure(
        tokens,
        row_gap_ratio=config.get('rowGapRatio', 0.6),
        column_gap_ratio=config.get('columnGapRatio', 1.5),
    )

    evidence_precision: Literal['page_only', 'text_span', 'cell_bbox'] = (
        'cell_bbox' if tables else 'page_only'
    )

    return ParserPageResultV1(
        page=page_number,
        width=str(page_width) if page_width is not None else None,
        height=str(page_height) if page_height is not None else None,
        rotation=rotation if rotation != 0 else None,
        text=full_text,
        markdown=None,
        printedPage=None,
        blocks=blocks,
        tables=tables,
        images=cast(list[ParsedImageRegionV1], []),
        confidence=None,
        evidencePrecision=evidence_precision,
        warnings=warnings,
    )


# ------------------------------------------------------------------ #
# Resource guardrails
# ------------------------------------------------------------------ #


class ResourceGuardrails:
    """Enforce per-job page limits and per-page timeouts."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.max_pages = config.get('maxPagesPerJob', 50)
        self.per_page_timeout = config.get('perPageTimeoutSeconds', 120)
        self.parallel = config.get('parallelProcessing', False)

    def check_page_count(self, requested_pages: list[int]) -> None:
        """Raise if the number of requested pages exceeds the limit."""
        if len(requested_pages) > self.max_pages:
            raise ValueError(
                f'requested {len(requested_pages)} pages exceeds '
                f'maxPagesPerJob limit of {self.max_pages}'
            )

    def get_timeout(self) -> float:
        """Return the per-page timeout in seconds."""
        return float(self.per_page_timeout)


# ------------------------------------------------------------------ #
# Main engine entry point
# ------------------------------------------------------------------ #


def run_paddleocr_engine(
    source_path: str | Path,
    expected_sha256: str,
    requested_pages: list[int],
    config: dict[str, Any] | None = None,
    job_id: str = 'paddleocr-job',
) -> ParserRuntimeResultV1:
    """Run the PaddleOCR engine on the requested pages.

    This is the main entry point called by the CLI.
    """
    cfg = config or get_default_config()
    config_sha = compute_config_sha256(cfg)

    # Source integrity
    verify_source_sha256(source_path, expected_sha256)
    actual_sha = compute_file_sha256(source_path)

    # Resource guardrails
    guardrails = ResourceGuardrails(cfg)
    guardrails.check_page_count(requested_pages)

    # Config warnings
    config_warnings = validate_config(cfg)

    start_time = time.monotonic()
    succeeded_pages: list[int] = []
    failed_pages: list[ParserPageFailureV1] = []
    page_results: list[ParserPageResultV1] = []
    runtime_warnings: list[ParserRuntimeWarningV1] = []

    if config_warnings:
        runtime_warnings.append(
            ParserRuntimeWarningV1(
                code='config_warning',
                message='; '.join(config_warnings),
                pages=requested_pages,
            )
        )

    # Get page dimensions from PDF
    page_dims: dict[int, tuple[float, float, int]] = {}
    try:
        import pdfplumber

        with pdfplumber.open(str(source_path)) as pdf:
            for page in pdf.pages:
                pn = int(page.page_number)
                if pn in requested_pages:
                    page_dims[pn] = (
                        float(page.width),
                        float(page.height),
                        int(getattr(page, 'rotation', 0) or 0),
                    )
    except ImportError:
        runtime_warnings.append(
            ParserRuntimeWarningV1(
                code='pdfplumber_unavailable',
                message='pdfplumber not available for page dimension lookup',
                pages=requested_pages,
            )
        )

    # Initialize PaddleOCR engine (lazy). Any failure to construct the
    # engine means this job cannot run, not that the whole process should
    # crash: fail every requested page with a real reason code and return a
    # valid result, so the router can compose whatever DID succeed in
    # earlier steps instead of aborting the entire multi-page parse plan.
    try:
        engine = _create_paddle_ocr(cfg)
    except (RuntimeError, ValueError, TypeError) as e:
        for pn in requested_pages:
            failed_pages.append(
                ParserPageFailureV1(
                    page=pn,
                    code='model_unavailable',
                    message=str(e),
                )
            )
        duration_ms = int((time.monotonic() - start_time) * 1000)
        metrics = ParserRuntimeMetricsV1(
            durationMillis=duration_ms,
            pagesProcessed=len(requested_pages),
            pagesSucceeded=0,
            pagesFailed=len(requested_pages),
            engineVersion=ENGINE_VERSION,
        )
        result_dict = {
            'schemaVersion': 'defense_budget_parser_result_v1',
            'jobId': job_id,
            'engine': ENGINE_NAME,
            'parserVersion': ENGINE_VERSION,
            'parserConfigSha256': config_sha,
            'inputSourceSha256': actual_sha,
            'requestedPages': requested_pages,
            'succeededPages': succeeded_pages,
            'failedPages': [f.model_dump() for f in failed_pages],
            'pages': [],
            'warnings': [w.model_dump() for w in runtime_warnings],
            'metrics': metrics.model_dump(),
        }
        content_sha = compute_result_content_sha256(result_dict)
        return ParserRuntimeResultV1(
            schemaVersion='defense_budget_parser_result_v1',
            jobId=job_id,
            engine=cast(Any, ENGINE_NAME),
            parserVersion=ENGINE_VERSION,
            parserConfigSha256=config_sha,
            inputSourceSha256=actual_sha,
            requestedPages=requested_pages,
            succeededPages=succeeded_pages,
            failedPages=failed_pages,
            pages=page_results,
            warnings=runtime_warnings,
            metrics=metrics,
            contentSha256=content_sha,
        )

    # Process each page
    dpi = cfg.get('dpi', 200)
    timeout = guardrails.get_timeout()

    for pn in requested_pages:
        try:
            img = render_page_to_image(source_path, pn, dpi=dpi)
            w, h, rot = page_dims.get(pn, (None, None, 0))

            page_start = time.monotonic()
            page_result = process_page_with_paddleocr(
                engine=engine,
                img=img,
                page_number=pn,
                config=cfg,
                page_width=w,
                page_height=h,
                rotation=rot,
            )
            page_elapsed = time.monotonic() - page_start

            if page_elapsed > timeout:
                runtime_warnings.append(
                    ParserRuntimeWarningV1(
                        code='page_timeout_exceeded',
                        message=f'page {pn} took {page_elapsed:.1f}s (limit {timeout}s)',
                        pages=[pn],
                    )
                )

            page_results.append(page_result)
            succeeded_pages.append(pn)

        except ValueError as e:
            failed_pages.append(
                ParserPageFailureV1(
                    page=pn,
                    code='page_out_of_range' if 'out of range' in str(e) else 'render_error',
                    message=str(e),
                )
            )
        except Exception as e:
            failed_pages.append(
                ParserPageFailureV1(
                    page=pn,
                    code='unknown_error',
                    message=f'{type(e).__name__}: {e}',
                )
            )

    duration_ms = int((time.monotonic() - start_time) * 1000)

    metrics = ParserRuntimeMetricsV1(
        durationMillis=duration_ms,
        pagesProcessed=len(requested_pages),
        pagesSucceeded=len(succeeded_pages),
        pagesFailed=len(failed_pages),
        engineVersion=ENGINE_VERSION,
        modelVersions=[ENGINE_VERSION],
    )

    result_dict = {
        'schemaVersion': 'defense_budget_parser_result_v1',
        'jobId': job_id,
        'engine': ENGINE_NAME,
        'parserVersion': ENGINE_VERSION,
        'parserConfigSha256': config_sha,
        'inputSourceSha256': actual_sha,
        'requestedPages': requested_pages,
        'succeededPages': succeeded_pages,
        'failedPages': [f.model_dump() for f in failed_pages],
        'pages': [p.model_dump() for p in page_results],
        'warnings': [w.model_dump() for w in runtime_warnings],
        'metrics': metrics.model_dump(),
    }
    content_sha = compute_result_content_sha256(result_dict)

    return ParserRuntimeResultV1(
        schemaVersion='defense_budget_parser_result_v1',
        jobId=job_id,
        engine=cast(Any, ENGINE_NAME),
        parserVersion=ENGINE_VERSION,
        parserConfigSha256=config_sha,
        inputSourceSha256=actual_sha,
        requestedPages=requested_pages,
        succeededPages=succeeded_pages,
        failedPages=failed_pages,
        pages=page_results,
        warnings=runtime_warnings,
        metrics=metrics,
        contentSha256=content_sha,
    )


# ------------------------------------------------------------------ #
# CLI entry for standalone invocation
# ------------------------------------------------------------------ #


def run_from_job_file(job_path: str | Path, output_path: str | Path) -> None:
    """Read a job JSON file, run the engine, write result JSON."""
    with open(job_path, encoding='utf-8') as f:
        job_data = json.load(f)

    config = job_data.get('parserConfig') or get_default_config()
    result = run_paddleocr_engine(
        source_path=job_data['sourcePath'],
        expected_sha256=job_data['sourceSha256'],
        requested_pages=job_data['requestedPages'],
        config=config,
        job_id=job_data.get('jobId', 'paddleocr-job'),
    )

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result.model_dump(), f, indent=2, ensure_ascii=False)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: paddleocr_engine.py <job.json> <result.json>')
        sys.exit(1)
    run_from_job_file(sys.argv[1], sys.argv[2])
