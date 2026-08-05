"""capiro_defense_budget_parser.docling_engine — Docling CPU mixed-layout engine.

Local CPU-only layout and reading-order parsing for digital pages containing
narratives, headings, and tables (Workstream H).

Constraints (per plan H1):
- CPU-only mode. No VLM pipeline, no remote LLM extraction, no external API
  keys, no GPU-only features.
- Page targeting: if Docling cannot restrict conversion to exact pages, a
  temporary page-subset PDF is created deterministically and an original-page
  mapping is maintained (H2).
- Output mapping: ordered text blocks, headings, paragraphs, tables, cell
  text, real geometry when available, reading order, page-level warnings.
  Generated Markdown alone is never treated as exact cell evidence (H3).
- Model/config identity recorded: package version, model versions, pipeline
  options, OCR state, CPU mode, config SHA (H4).

This engine must never:
- connect to Postgres
- access AWS credentials
- call LlamaParse
- write canonical data
- determine verification decisions
- select a winning parser result
- know tenant/client data
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Literal, cast

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
# Engine identity (H4)
# ------------------------------------------------------------------ #

ENGINE_NAME = 'docling'

# Lazy import so the module loads without Docling installed.
try:
    import docling  # type: ignore[import-not-found]

    DOCLING_PACKAGE_VERSION: str | None = getattr(docling, '__version__', 'unknown')
except ImportError:
    DOCLING_PACKAGE_VERSION = None

ENGINE_VERSION = f'docling-{DOCLING_PACKAGE_VERSION or "unavailable"}-cpu'

# ------------------------------------------------------------------ #
# Default configuration (H1, H4)
# ------------------------------------------------------------------ #

DEFAULT_DOCLING_CONFIG: dict[str, Any] = {
    'cpuMode': True,
    'vlmPipeline': False,
    'remoteLlmExtraction': False,
    'ocrEnabled': False,
    'gpuEnabled': False,
    'pipelineOptions': {
        'doTableStructure': True,
        'doOcr': False,
        'doLayout': True,
        'doReadingOrder': True,
    },
    'maxPagesPerJob': 100,
    'perPageTimeoutSeconds': 180,
    'modelCachePath': None,
}


def get_default_config() -> dict[str, Any]:
    """Return a deep copy of the default Docling config."""
    import copy

    return copy.deepcopy(DEFAULT_DOCLING_CONFIG)


def compute_config_sha256(config: dict[str, Any]) -> str:
    """Compute the canonical config SHA-256."""
    return compute_parser_config_sha256(config)


# ------------------------------------------------------------------ #
# Config validation (H1)
# ------------------------------------------------------------------ #


def validate_config(config: dict[str, Any]) -> list[str]:
    """Validate Docling config; return warnings (empty if OK)."""
    warnings: list[str] = []

    if config.get('vlmPipeline', False):
        warnings.append('VLM pipeline is forbidden in Phase 3; forcing standard pipeline')
    if config.get('remoteLlmExtraction', False):
        warnings.append('remote LLM extraction is forbidden in Phase 3')
    if config.get('gpuEnabled', False):
        warnings.append('GPU mode is not supported in Phase 3; forcing CPU')

    max_pages = config.get('maxPagesPerJob', 100)
    if not isinstance(max_pages, int) or max_pages < 1:
        warnings.append('maxPagesPerJob must be a positive integer')

    timeout = config.get('perPageTimeoutSeconds', 180)
    if not isinstance(timeout, (int, float)) or timeout < 1:
        warnings.append('perPageTimeoutSeconds must be >= 1')

    return warnings


# ------------------------------------------------------------------ #
# Page subset extraction (H2)
# ------------------------------------------------------------------ #


def _create_page_subset_pdf(
    source_path: str | Path,
    requested_pages: list[int],
    output_path: str | Path,
) -> dict[int, int]:
    """Create a temporary PDF containing only the requested pages.

    Returns a mapping: subset_page_number (1-based) -> original_page_number.

    Uses PyMuPDF (fitz) when available, falls back to pypdf.
    """
    try:
        import fitz  # type: ignore[import-not-found]  # PyMuPDF

        src_doc = fitz.open(str(source_path))
        total_pages = len(src_doc)

        # Validate requested pages
        for p in requested_pages:
            if p < 1 or p > total_pages:
                src_doc.close()
                raise ValueError(f'page {p} out of range (1-{total_pages})')

        out_doc = fitz.open()
        page_map: dict[int, int] = {}

        for subset_idx, original_page in enumerate(requested_pages, start=1):
            out_doc.insert_pdf(src_doc, from_page=original_page - 1, to_page=original_page - 1)
            page_map[subset_idx] = original_page

        out_doc.save(str(output_path))
        out_doc.close()
        src_doc.close()

        return page_map

    except ImportError:
        pass

    # Fallback: pypdf
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as e:
        raise RuntimeError(
            'Neither PyMuPDF nor pypdf is available for page-subset extraction. '
            'Install one of: pymupdf, pypdf'
        ) from e

    reader = PdfReader(str(source_path))
    total_pages = len(reader.pages)

    for p in requested_pages:
        if p < 1 or p > total_pages:
            raise ValueError(f'page {p} out of range (1-{total_pages})')

    writer = PdfWriter()
    page_map = {}

    for subset_idx, original_page in enumerate(requested_pages, start=1):
        writer.add_page(reader.pages[original_page - 1])
        page_map[subset_idx] = original_page

    with open(output_path, 'wb') as f:
        writer.write(f)

    return page_map


# ------------------------------------------------------------------ #
# Docling conversion (H1, H3)
# ------------------------------------------------------------------ #


def _create_docling_converter(config: dict[str, Any]) -> Any:
    """Create a Docling DocumentConverter with CPU-only, no-VLM settings."""
    if docling is None:
        raise RuntimeError('Docling is not installed. Install with: pip install docling')

    try:
        from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            'Docling DocumentConverter not available. Ensure docling>=2.5 is installed.'
        ) from e

    # Build pipeline options — CPU only, no VLM, no remote
    pipeline_kwargs: dict[str, Any] = {}

    opts = config.get('pipelineOptions', {})
    if isinstance(opts, dict):
        if opts.get('doTableStructure', True):
            pipeline_kwargs['do_table_structure'] = True
        if opts.get('doOcr', False):
            pipeline_kwargs['do_ocr'] = False  # force off per H1
        if opts.get('doLayout', True):
            pipeline_kwargs['do_layout'] = True
        if opts.get('doReadingOrder', True):
            pipeline_kwargs['do_reading_order'] = True

    # Force CPU, no VLM, no remote LLM
    converter_kwargs: dict[str, Any] = {
        'do_ocr': False,
        'do_table_structure': pipeline_kwargs.get('do_table_structure', True),
        'do_layout': pipeline_kwargs.get('do_layout', True),
        'do_reading_order': pipeline_kwargs.get('do_reading_order', True),
    }

    return DocumentConverter(**converter_kwargs)


def _bbox_from_docling(bbox_obj: Any) -> BoundingBoxV1 | None:
    """Convert a Docling bounding box to BoundingBoxV1, or None if unavailable."""
    if bbox_obj is None:
        return None
    try:
        # Docling bbox objects have .l, .t, .r, .b (left, top, right, bottom)
        # or .x0, .y0, .x1, .y1 depending on version
        if hasattr(bbox_obj, 'l') and hasattr(bbox_obj, 't'):
            return BoundingBoxV1(
                x0=str(bbox_obj.l),
                y0=str(bbox_obj.t),
                x1=str(bbox_obj.r),
                y1=str(bbox_obj.b),
            )
        if hasattr(bbox_obj, 'x0'):
            return BoundingBoxV1(
                x0=str(bbox_obj.x0),
                y0=str(bbox_obj.y0),
                x1=str(bbox_obj.x1),
                y1=str(bbox_obj.y1),
            )
        if isinstance(bbox_obj, (list, tuple)) and len(bbox_obj) == 4:
            return BoundingBoxV1(
                x0=str(bbox_obj[0]),
                y0=str(bbox_obj[1]),
                x1=str(bbox_obj[2]),
                y1=str(bbox_obj[3]),
            )
    except (AttributeError, TypeError, IndexError):
        pass
    return None


def _map_docling_item_to_block(
    item: Any,
    block_index: int,
) -> LayoutBlockV1 | None:
    """Map a Docling document item to a LayoutBlockV1."""
    item_type = getattr(item, 'label', None) or getattr(item, 'type', 'unknown')
    text = getattr(item, 'text', '') or ''
    bbox = _bbox_from_docling(getattr(item, 'prov', None))

    # Map Docling labels to our block types
    type_map: dict[str, str] = {
        'title': 'heading',
        'section-header': 'heading',
        'paragraph': 'paragraph',
        'text': 'text',
        'list-item': 'list_item',
        'table': 'table',
        'picture': 'image',
        'figure': 'image',
        'caption': 'caption',
        'page-header': 'header',
        'page-footer': 'footer',
        'footnote': 'text',
        'formula': 'text',
    }
    block_type = cast(
        Literal[
            'text',
            'heading',
            'paragraph',
            'list_item',
            'table',
            'image',
            'header',
            'footer',
            'caption',
            'unknown',
        ],
        type_map.get(str(item_type).lower(), 'unknown'),
    )

    if not text and block_type != 'image':
        return None

    return LayoutBlockV1(
        blockIndex=block_index,
        blockType=block_type,
        text=str(text),
        readingOrder=block_index,
        boundingBox=bbox,
    )


def _map_docling_table(
    table_item: Any,
    table_index: int,
    page_number: int,
) -> ParsedTableV1 | None:
    """Map a Docling table item to ParsedTableV1.

    Docling tables expose a grid of cells with text and optional bounding
    boxes. We preserve real geometry only; never fabricate cell boxes (H3).
    """
    cells: list[ParsedTableCellV1] = []
    max_row = -1
    max_col = -1

    # Docling table data access
    table_data = getattr(table_item, 'data', None)
    if table_data is None:
        return None

    grid = getattr(table_data, 'grid', None) or getattr(table_data, 'cells', None)
    if grid is None:
        return None

    # Grid is list[list[cell]] or list of cell objects
    for row_idx, row in enumerate(grid):
        if not isinstance(row, (list, tuple)):
            continue
        for col_idx, cell in enumerate(row):
            # Extract text: prefer .text attribute, fall back to str(cell)
            raw_text = getattr(cell, 'text', None)
            if raw_text is not None and isinstance(raw_text, str):
                cell_text = raw_text
            elif raw_text is not None:
                cell_text = str(raw_text)
            else:
                cell_text = str(cell) if not hasattr(cell, 'text') else ''
            cell_bbox = _bbox_from_docling(getattr(cell, 'prov', None))
            row_span = getattr(cell, 'row_span', None) or getattr(cell, 'rowspan', None)
            col_span = getattr(cell, 'col_span', None) or getattr(cell, 'colspan', None)

            cells.append(
                ParsedTableCellV1(
                    rowIndex=row_idx,
                    columnIndex=col_idx,
                    text=str(cell_text).strip(),
                    rowSpan=int(row_span) if row_span and int(row_span) > 1 else None,
                    colSpan=int(col_span) if col_span and int(col_span) > 1 else None,
                    boundingBox=cell_bbox,
                    confidence=None,
                )
            )
            max_row = max(max_row, row_idx)
            max_col = max(max_col, col_idx)

    if not cells:
        return None

    table_bbox = _bbox_from_docling(getattr(table_item, 'prov', None))
    label = getattr(table_item, 'label', None) or getattr(table_item, 'caption', None)

    return ParsedTableV1(
        tableIndex=table_index,
        label=str(label) if label else None,
        rowCount=max_row + 1,
        columnCount=max_col + 1,
        cells=cells,
        boundingBox=table_bbox,
        warnings=[],
    )


def process_page_with_docling(
    converter: Any,
    pdf_path: str | Path,
    page_number: int,
    config: dict[str, Any],
    page_map: dict[int, int] | None = None,
) -> ParserPageResultV1:
    """Process a single page with Docling.

    If page_map is provided, page_number is the subset page and the mapping
    translates to the original physical page number for the result.
    """
    warnings: list[str] = []

    # Determine the original page number for the result
    original_page = page_map.get(page_number, page_number) if page_map else page_number

    # Convert the document (Docling converts the whole subset PDF)
    try:
        result = converter.convert(str(pdf_path))
    except Exception as e:
        warnings.append(f'Docling conversion error on page {original_page}: {e}')
        return ParserPageResultV1(
            page=original_page,
            width=None,
            height=None,
            rotation=None,
            text=None,
            markdown=None,
            printedPage=None,
            blocks=[],
            tables=[],
            images=[],
            confidence=None,
            evidencePrecision='page_only',
            warnings=warnings,
        )

    # Extract items from the converted document
    blocks: list[LayoutBlockV1] = []
    tables: list[ParsedTableV1] = []
    all_text_parts: list[str] = []
    block_index = 0
    table_index = 0

    doc = getattr(result, 'document', None)
    if doc is None:
        warnings.append(f'Docling returned no document for page {original_page}')
        return ParserPageResultV1(
            page=original_page,
            width=None,
            height=None,
            rotation=None,
            text=None,
            markdown=None,
            printedPage=None,
            blocks=[],
            tables=[],
            images=[],
            confidence=None,
            evidencePrecision='page_only',
            warnings=warnings,
        )

    # Iterate over document items (blocks and tables)
    items = getattr(doc, 'items', None) or getattr(doc, 'body', [])
    if not isinstance(items, (list, tuple)):
        items = []

    for item in items:
        item_type = getattr(item, 'label', None) or getattr(item, 'type', '')
        is_table = str(item_type).lower() in ('table',)

        if is_table:
            table = _map_docling_table(item, table_index, original_page)
            if table:
                tables.append(table)
                table_index += 1
                # Also add as a block for reading order
                table_text = ' | '.join(
                    cell.text
                    for row in [
                        [c for c in table.cells if c.rowIndex == r] for r in range(table.rowCount)
                    ]
                    for cell in row
                    if cell.text
                )
                if table_text:
                    all_text_parts.append(table_text)
        else:
            block = _map_docling_item_to_block(item, block_index)
            if block:
                blocks.append(block)
                block_index += 1
                if block.text:
                    all_text_parts.append(block.text)

    # Extract markdown if available
    markdown_text = None
    if hasattr(doc, 'export_to_markdown'):
        import contextlib

        with contextlib.suppress(Exception):
            markdown_text = doc.export_to_markdown()

    full_text = '\n'.join(all_text_parts) if all_text_parts else None

    # Determine evidence precision
    has_cell_bbox = any(cell.boundingBox is not None for t in tables for cell in t.cells)
    evidence_precision: Literal['page_only', 'text_span', 'cell_bbox'] = (
        'cell_bbox' if has_cell_bbox else ('text_span' if blocks else 'page_only')
    )

    # Config-driven warnings
    if config.get('vlmPipeline', False):
        warnings.append('VLM pipeline was requested but is forbidden; standard pipeline used')
    if config.get('ocrEnabled', False):
        warnings.append('OCR was requested but is disabled per Phase 3 policy')

    return ParserPageResultV1(
        page=original_page,
        width=None,
        height=None,
        rotation=None,
        text=full_text,
        markdown=markdown_text,
        printedPage=None,
        blocks=blocks,
        tables=tables,
        images=[],
        confidence=None,
        evidencePrecision=evidence_precision,
        warnings=warnings,
    )


# ------------------------------------------------------------------ #
# Main engine entry point
# ------------------------------------------------------------------ #


def run_docling_engine(
    source_path: str | Path,
    expected_sha256: str,
    requested_pages: list[int],
    config: dict[str, Any] | None = None,
    job_id: str = 'docling-job',
) -> ParserRuntimeResultV1:
    """Run the Docling engine on the requested pages.

    This is the main entry point called by the CLI.
    """
    cfg = config or get_default_config()
    config_sha = compute_config_sha256(cfg)

    # Source integrity
    verify_source_sha256(source_path, expected_sha256)
    actual_sha = compute_file_sha256(source_path)

    # Guardrails
    max_pages = cfg.get('maxPagesPerJob', 100)
    if len(requested_pages) > max_pages:
        raise ValueError(
            f'requested {len(requested_pages)} pages exceeds maxPagesPerJob limit of {max_pages}'
        )

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

    # Initialize Docling converter (lazy)
    try:
        converter = _create_docling_converter(cfg)
    except RuntimeError as e:
        # Docling not installed — fail all pages
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
            modelVersions=_collect_model_versions(cfg),
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

    # Create page-subset PDF for targeted conversion (H2)
    import tempfile

    page_map: dict[int, int] = {}
    subset_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            subset_path = tmp.name

        page_map = _create_page_subset_pdf(source_path, requested_pages, subset_path)

        # Process each page through the subset
        for subset_page, original_page in sorted(page_map.items()):
            try:
                page_result = process_page_with_docling(
                    converter=converter,
                    pdf_path=subset_path,
                    page_number=subset_page,
                    config=cfg,
                    page_map=page_map,
                )
                page_results.append(page_result)
                succeeded_pages.append(original_page)
            except Exception as e:
                failed_pages.append(
                    ParserPageFailureV1(
                        page=original_page,
                        code='pdf_parse_error',
                        message=f'Docling processing error: {e}',
                    )
                )
    except (ValueError, RuntimeError) as e:
        # Page subset creation failed — fail all pages
        for pn in requested_pages:
            failed_pages.append(
                ParserPageFailureV1(
                    page=pn,
                    code='pdf_parse_error',
                    message=str(e),
                )
            )
    finally:
        # Clean up temporary subset PDF
        if subset_path:
            import contextlib

            with contextlib.suppress(OSError):
                Path(subset_path).unlink(missing_ok=True)

    # Sort results by original page number
    page_results.sort(key=lambda r: r.page)
    succeeded_pages.sort()
    failed_pages.sort(key=lambda f: f.page)

    duration_ms = int((time.monotonic() - start_time) * 1000)
    metrics = ParserRuntimeMetricsV1(
        durationMillis=duration_ms,
        pagesProcessed=len(requested_pages),
        pagesSucceeded=len(succeeded_pages),
        pagesFailed=len(failed_pages),
        engineVersion=ENGINE_VERSION,
        modelVersions=_collect_model_versions(cfg),
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


def _collect_model_versions(config: dict[str, Any]) -> list[str]:
    """Collect model/package versions that affect output (H4)."""
    versions = [ENGINE_VERSION]
    if DOCLING_PACKAGE_VERSION:
        versions.append(f'docling-package-{DOCLING_PACKAGE_VERSION}')
    opts = config.get('pipelineOptions', {})
    if isinstance(opts, dict):
        if opts.get('doTableStructure', True):
            versions.append('table-structure-v1')
        if opts.get('doReadingOrder', True):
            versions.append('reading-order-v1')
    return versions
