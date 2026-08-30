"""capiro_defense_budget_parser.pdfplumber_engine — cheapest default parser for clean digital PDFs.

Page-scoped execution: opens source once, processes only requested one-based pages.
Returns embedded text, words with coordinates, lines/rectangles, extracted tables,
cell text with real bounding boxes, page dimensions/rotation, and warnings.

Money values remain strings. No fake bounding boxes are generated.
"""

from __future__ import annotations

import time
from collections import Counter
from pathlib import Path
from typing import Any

try:
    import pdfplumber as _pdfplumber_module  # noqa: F401 — for test patching

    pdfplumber = _pdfplumber_module  # re-export for module-level patch access
except ImportError:
    _pdfplumber_module = None  # type: ignore[assignment]
    pdfplumber = None  # type: ignore[assignment]

from .contracts import (
    BoundingBoxV1,
    LayoutBlockV1,
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
from .pdf_profile import compute_file_sha256, verify_source_sha256

# ------------------------------------------------------------------ #
# Engine identity
# ------------------------------------------------------------------ #

ENGINE_NAME = 'deterministic_pdfplumber'
ENGINE_VERSION = 'pdfplumber-0.11.0'

# ------------------------------------------------------------------ #
# Table strategy profiles (F2)
# ------------------------------------------------------------------ #

TABLE_STRATEGIES: dict[str, dict[str, Any]] = {
    'lines': {
        'vertical_strategy': 'lines',
        'horizontal_strategy': 'lines',
    },
    'lines_strict': {
        'vertical_strategy': 'lines_strict',
        'horizontal_strategy': 'lines_strict',
    },
    'text': {
        'vertical_strategy': 'text',
        'horizontal_strategy': 'text',
    },
    'hybrid': {
        'vertical_strategy': 'lines',
        'horizontal_strategy': 'text',
    },
}

DEFAULT_TABLE_STRATEGY = 'lines'


def get_table_strategy_config(strategy_name: str) -> dict[str, Any]:
    """Return the pdfplumber table settings for a named strategy."""
    if strategy_name not in TABLE_STRATEGIES:
        raise ValueError(f'unknown table strategy: {strategy_name}')
    return dict(TABLE_STRATEGIES[strategy_name])


def build_default_config(strategy: str = DEFAULT_TABLE_STRATEGY) -> dict[str, Any]:
    """Build the default pdfplumber engine config."""
    return {
        'tableStrategy': strategy,
        'tableSettings': get_table_strategy_config(strategy),
    }


def compute_config_sha256(config: dict[str, Any]) -> str:
    return compute_parser_config_sha256(config)


# ------------------------------------------------------------------ #
# Page-scoped execution
# ------------------------------------------------------------------ #


def _to_decimal_string(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return repr(value)


# Phase 10B-16 Part C: classification zones, as a fraction of page height,
# for the running header/footer band real DoD budget exhibit pages use.
# Empirically calibrated against the real FY2024 Army R-2 Volume 1 BA1 PDF
# (landscape Letter, 792x612): on the PE 0601102A exhibit page the entire
# fixed per-page context block -- classification banner, "Date:"/"Exhibit
# R-2..." line, and the Appropriation/BA + PE-number/title row -- sits
# within the top ~117pt (19.1%) of the page; the repeated footer block
# (classification banner, PE code, volume/page numbers) sits within the
# bottom ~44pt (7.2%). Both zones are structural (position-only): they say
# nothing about what the text means, only where it physically sits.
HEADER_ZONE_HEIGHT_RATIO = 0.22
FOOTER_ZONE_HEIGHT_RATIO = 0.08

# A line is heading-weight when its dominant font is bold/bold-italic, or
# its size is meaningfully larger than the page's modal (most common) body
# size. This replaces a markdown '#' check that real PDFs never satisfy.
HEADING_SIZE_DELTA = 1.0


def _extract_blocks(page: Any) -> list[LayoutBlockV1]:
    """Extract text blocks from a pdfplumber page.

    blockType is assigned from purely structural evidence -- position on the
    page and font size/weight -- never from the text's content. Semantic
    interpretation (is this a PE number? an appropriation line?) is the
    downstream TS segmenter/extractors' job, not this function's.
    """
    blocks: list[LayoutBlockV1] = []

    try:
        words = page.extract_words(
            keep_blank_chars=False, use_text_flow=True, extra_attrs=['size', 'fontname']
        )
    except Exception:
        words = []

    if not words:
        return blocks

    # Group words into lines by their 'top' coordinate
    lines: dict[float, list[dict[str, Any]]] = {}
    for word in words:
        top = round(float(word.get('top', 0)), 1)
        if top not in lines:
            lines[top] = []
        lines[top].append(word)

    page_height = float(getattr(page, 'height', 0) or 0)
    header_cutoff = page_height * HEADER_ZONE_HEIGHT_RATIO
    footer_cutoff = page_height * (1 - FOOTER_ZONE_HEIGHT_RATIO)

    all_sizes = [round(float(w['size']), 1) for w in words if w.get('size')]
    body_size = Counter(all_sizes).most_common(1)[0][0] if all_sizes else 0.0

    for idx, (_, line_words) in enumerate(sorted(lines.items())):
        text = ' '.join(w.get('text', '') for w in line_words)
        if not text.strip():
            continue

        x0 = min(float(w.get('x0', 0)) for w in line_words)
        y0 = min(float(w.get('top', 0)) for w in line_words)
        x1 = max(float(w.get('x1', 0)) for w in line_words)
        y1 = max(float(w.get('bottom', 0)) for w in line_words)

        line_sizes = [round(float(w['size']), 1) for w in line_words if w.get('size')]
        line_size = max(line_sizes) if line_sizes else 0.0
        is_bold = any('bold' in str(w.get('fontname', '')).lower() for w in line_words)

        block_type: str = 'text'
        if page_height > 0 and y1 <= header_cutoff:
            block_type = 'header'
        elif page_height > 0 and y0 >= footer_cutoff:
            block_type = 'footer'
        elif is_bold or (body_size > 0 and line_size >= body_size + HEADING_SIZE_DELTA):
            block_type = 'heading'

        blocks.append(
            LayoutBlockV1(
                blockIndex=idx,
                blockType=block_type,  # type: ignore[arg-type]
                text=text.strip(),
                readingOrder=idx,
                boundingBox=BoundingBoxV1(
                    x0=_to_decimal_string(x0),
                    y0=_to_decimal_string(y0),
                    x1=_to_decimal_string(x1),
                    y1=_to_decimal_string(y1),
                ),
            )
        )

    return blocks


def _extract_tables(page: Any, table_settings: dict[str, Any]) -> list[ParsedTableV1]:
    """Extract tables from a pdfplumber page using the given settings."""
    tables: list[ParsedTableV1] = []

    try:
        raw_tables = page.find_tables(table_settings=table_settings)
    except Exception:
        return tables

    for t_idx, raw_table in enumerate(raw_tables):
        try:
            data = raw_table.extract()
        except Exception:
            continue

        if not data or len(data) < 1:
            continue

        row_count = len(data)
        col_count = max(len(row) for row in data) if data else 0
        cells: list[ParsedTableCellV1] = []

        for r_idx, row in enumerate(data):
            for c_idx in range(col_count):
                cell_text = ''
                if c_idx < len(row) and row[c_idx] is not None:
                    cell_text = str(row[c_idx]).strip()

                # Real cell bounding box from the table's bbox cells
                bbox = None
                try:
                    if hasattr(raw_table, 'cells') and raw_table.cells:
                        cell_key = (r_idx, c_idx)
                        if cell_key in raw_table.cells:
                            cb = raw_table.cells[cell_key]
                            if cb and len(cb) >= 4:
                                bbox = BoundingBoxV1(
                                    x0=_to_decimal_string(float(cb[0])),
                                    y0=_to_decimal_string(float(cb[1])),
                                    x1=_to_decimal_string(float(cb[2])),
                                    y1=_to_decimal_string(float(cb[3])),
                                )
                except Exception:
                    pass

                cells.append(
                    ParsedTableCellV1(
                        rowIndex=r_idx,
                        columnIndex=c_idx,
                        text=cell_text,
                        boundingBox=bbox,
                    )
                )

        # Table-level bounding box
        table_bbox = None
        try:
            if hasattr(raw_table, 'bbox') and raw_table.bbox:
                tb = raw_table.bbox
                if len(tb) >= 4:
                    table_bbox = BoundingBoxV1(
                        x0=_to_decimal_string(float(tb[0])),
                        y0=_to_decimal_string(float(tb[1])),
                        x1=_to_decimal_string(float(tb[2])),
                        y1=_to_decimal_string(float(tb[3])),
                    )
        except Exception:
            pass

        tables.append(
            ParsedTableV1(
                tableIndex=t_idx,
                rowCount=row_count,
                columnCount=col_count,
                cells=cells,
                boundingBox=table_bbox,
                warnings=[],
            )
        )

    return tables


def process_page(
    page: Any,
    page_number: int,
    table_settings: dict[str, Any],
    config: dict[str, Any],
) -> ParserPageResultV1:
    """Process a single pdfplumber page."""
    warnings: list[str] = []

    width = float(page.width)
    height = float(page.height)
    rotation = int(getattr(page, 'rotation', 0) or 0)

    # Extract embedded text
    try:
        text = page.extract_text() or ''
    except Exception:
        text = ''
        warnings.append('text extraction error')

    # Extract blocks
    blocks = _extract_blocks(page)

    # Extract tables
    tables = _extract_tables(page, table_settings)

    # Determine evidence precision
    # If we have tables with cell bounding boxes, use cell_bbox
    has_cell_bbox = any(any(c.boundingBox is not None for c in t.cells) for t in tables)
    if has_cell_bbox:
        evidence_precision = 'cell_bbox'
    elif tables:
        evidence_precision = 'page_only'
    else:
        evidence_precision = 'page_only'

    # Check for no table on a page — not necessarily a failure (F4)
    if not tables and text:
        # Narrative-only page — not a parser failure
        pass

    return ParserPageResultV1(
        page=page_number,
        width=_to_decimal_string(width),
        height=_to_decimal_string(height),
        rotation=rotation if rotation != 0 else None,
        text=text or None,
        markdown=None,
        printedPage=None,
        blocks=blocks,
        tables=tables,
        images=[],
        evidencePrecision=evidence_precision,  # type: ignore[arg-type]
        warnings=warnings,
    )


def run_pdfplumber_engine(
    source_path: str | Path,
    expected_sha256: str,
    requested_pages: list[int],
    config: dict[str, Any] | None = None,
    job_id: str = 'pdfplumber-job',
) -> ParserRuntimeResultV1:
    """Run the pdfplumber engine on the requested pages."""
    cfg = config or build_default_config()
    config_sha = compute_config_sha256(cfg)

    # Source integrity
    verify_source_sha256(source_path, expected_sha256)
    actual_sha = compute_file_sha256(source_path)

    # Table settings
    strategy = cfg.get('tableStrategy', DEFAULT_TABLE_STRATEGY)
    table_settings = cfg.get('tableSettings', get_table_strategy_config(strategy))

    start_time = time.monotonic()
    succeeded_pages: list[int] = []
    failed_pages: list[ParserPageFailureV1] = []
    page_results: list[ParserPageResultV1] = []
    runtime_warnings: list[ParserRuntimeWarningV1] = []

    try:
        if pdfplumber is None:
            raise ImportError('pdfplumber is not installed')
    except ImportError as e:
        for pn in requested_pages:
            failed_pages.append(
                ParserPageFailureV1(
                    page=pn,
                    code='pdf_parse_error',
                    message=str(e),
                )
            )
        metrics = ParserRuntimeMetricsV1(
            durationMillis=0,
            pagesProcessed=len(requested_pages),
            pagesSucceeded=0,
            pagesFailed=len(requested_pages),
            engineVersion=ENGINE_VERSION,
        )
        return _build_result(
            job_id,
            config_sha,
            actual_sha,
            requested_pages,
            succeeded_pages,
            failed_pages,
            page_results,
            runtime_warnings,
            metrics,
        )

    page_set = set(requested_pages)
    total_pages = 0

    with pdfplumber.open(str(source_path)) as pdf:
        total_pages = len(pdf.pages)
        for page in pdf.pages:
            pn = int(page.page_number)
            if pn not in page_set:
                continue

            try:
                if pn > total_pages or pn < 1:
                    failed_pages.append(
                        ParserPageFailureV1(
                            page=pn,
                            code='page_out_of_range',
                            message=f'page {pn} out of range (1-{total_pages})',
                        )
                    )
                    continue

                result = process_page(page, pn, table_settings, cfg)
                page_results.append(result)
                succeeded_pages.append(pn)

            except Exception as e:
                failed_pages.append(
                    ParserPageFailureV1(
                        page=pn,
                        code='pdf_parse_error',
                        message=f'{type(e).__name__}: {e}',
                    )
                )

    duration_ms = int((time.monotonic() - start_time) * 1000)

    # Check for pages with no embedded text
    for result in page_results:
        if result.text is None and not result.blocks:
            # Page had no extractable text
            idx = succeeded_pages.index(result.page)
            succeeded_pages.pop(idx)
            page_results.pop(idx)
            failed_pages.append(
                ParserPageFailureV1(
                    page=result.page,
                    code='no_embedded_text',
                    message='page has no embedded text layer',
                )
            )

    metrics = ParserRuntimeMetricsV1(
        durationMillis=duration_ms,
        pagesProcessed=len(requested_pages),
        pagesSucceeded=len(succeeded_pages),
        pagesFailed=len(failed_pages),
        engineVersion=ENGINE_VERSION,
    )

    return _build_result(
        job_id,
        config_sha,
        actual_sha,
        requested_pages,
        succeeded_pages,
        failed_pages,
        page_results,
        runtime_warnings,
        metrics,
    )


def _build_result(
    job_id: str,
    config_sha: str,
    source_sha: str,
    requested_pages: list[int],
    succeeded_pages: list[int],
    failed_pages: list[ParserPageFailureV1],
    page_results: list[ParserPageResultV1],
    warnings: list[ParserRuntimeWarningV1],
    metrics: ParserRuntimeMetricsV1,
) -> ParserRuntimeResultV1:
    result_dict = {
        'schemaVersion': 'defense_budget_parser_result_v1',
        'jobId': job_id,
        'engine': ENGINE_NAME,
        'parserVersion': ENGINE_VERSION,
        'parserConfigSha256': config_sha,
        'inputSourceSha256': source_sha,
        'requestedPages': requested_pages,
        'succeededPages': succeeded_pages,
        'failedPages': [f.model_dump() for f in failed_pages],
        'pages': [p.model_dump() for p in page_results],
        'warnings': [w.model_dump() for w in warnings],
        'metrics': metrics.model_dump(),
    }
    content_sha = compute_result_content_sha256(result_dict)

    return ParserRuntimeResultV1(
        schemaVersion='defense_budget_parser_result_v1',
        jobId=job_id,
        engine=ENGINE_NAME,  # type: ignore[arg-type]
        parserVersion=ENGINE_VERSION,
        parserConfigSha256=config_sha,
        inputSourceSha256=source_sha,
        requestedPages=requested_pages,
        succeededPages=succeeded_pages,
        failedPages=failed_pages,
        pages=page_results,
        warnings=warnings,
        metrics=metrics,
        contentSha256=content_sha,
    )
