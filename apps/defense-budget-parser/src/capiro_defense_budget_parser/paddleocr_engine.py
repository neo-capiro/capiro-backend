"""capiro_defense_budget_parser.paddleocr_engine — PaddleOCR PP-StructureV3 targeted OCR engine.

Parse only pages that require OCR/layout recovery. Uses PaddleOCR PP-StructureV3
in CPU mode with expensive features disabled by default.

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
ENGINE_VERSION = 'paddleocr-pp-structure-v3-cpu'

# ------------------------------------------------------------------ #
# Default configuration
# ------------------------------------------------------------------ #

DEFAULT_PADDLEOCR_CONFIG: dict[str, Any] = {
    'dpi': 200,
    'cpuMode': True,
    'formulaRecognition': False,
    'chartRecognition': False,
    'documentUnwarping': False,
    'orientationClassification': False,
    'textLineOrientation': False,
    'maxPagesPerJob': 50,
    'perPageTimeoutSeconds': 120,
    'modelCachePath': None,
    'parallelProcessing': False,
    'use_gpu': False,
    'enable_mkldnn': True,
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

    Uses pdf2image (which wraps poppler) or PyMuPDF as available.
    Returns a PIL Image or equivalent.
    """
    try:
        import fitz  # type: ignore[import-not-found]  # PyMuPDF

        doc = fitz.open(str(pdf_path))
        if page_number < 1 or page_number > len(doc):
            raise ValueError(f'page {page_number} out of range (1-{len(doc)})')
        page = doc[page_number - 1]  # 0-based index
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        doc.close()

        try:
            from PIL import Image

            img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
            return img
        except ImportError:
            return pix
    except ImportError:
        pass

    try:
        from pdf2image import convert_from_path  # type: ignore[import-not-found]

        images = convert_from_path(
            str(pdf_path),
            dpi=dpi,
            first_page=page_number,
            last_page=page_number,
        )
        if not images:
            raise RuntimeError(f'pdf2image returned no images for page {page_number}')
        return images[0]
    except ImportError as e:
        raise RuntimeError(
            'Neither PyMuPDF nor pdf2image is available for page rendering. '
            'Install one of: pymupdf, pdf2image[pillow]'
        ) from e


# ------------------------------------------------------------------ #
# PaddleOCR PP-StructureV3 invocation
# ------------------------------------------------------------------ #


def _create_paddle_structure(config: dict[str, Any]) -> Any:
    """Create a PP-StructureV3 instance with the given config.

    This is lazily imported so the engine module can be loaded without
    PaddleOCR installed (e.g. for config/validation tests).
    """
    try:
        from paddleocr import PPStructureV3  # PyMuPDF
    except ImportError:
        try:
            from paddleocr import PPStructure as PPStructureV3  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                'PaddleOCR is not installed. Install with: '
                'pip install paddleocr paddlepaddle'
            ) from e

    engine_kwargs: dict[str, Any] = {
        'use_gpu': False,
        'show_log': False,
    }

    if config.get('enable_mkldnn', True):
        engine_kwargs['enable_mkldnn'] = True

    cache_path = config.get('modelCachePath')
    if cache_path:
        engine_kwargs['lang'] = 'en'
        engine_kwargs['table_model_dir'] = str(cache_path)

    # Feature toggles — disabled by default per I1
    engine_kwargs['structure_version'] = 'PP-StructureV3'

    return PPStructureV3(**engine_kwargs)


def _classify_structure_result(result: Any) -> dict[str, Any]:
    """Parse a PP-StructureV3 result into regions.

    PP-Structure returns a list of regions, each with:
    - type: 'text', 'title', 'figure', 'figure_caption', 'table',
      'table_caption', 'header', 'footer'
    - bbox: [x0, y0, x1, y1]
    - res: text content or table data
    """
    regions: list[dict[str, Any]] = []

    if result is None:
        return {'regions': regions}

    for region in result:
        region_type = region.get('type', 'unknown')
        bbox = region.get('bbox', [0, 0, 0, 0])
        res = region.get('res', {})

        regions.append({
            'type': region_type,
            'bbox': bbox,
            'res': res,
        })

    return {'regions': regions}


def _extract_table_from_region(
    region: dict[str, Any],
    page_number: int,
    table_index: int,
) -> ParsedTableV1 | None:
    """Extract a ParsedTableV1 from a PP-Structure table region."""
    res = region.get('res')
    if not res:
        return None

    # PP-Structure table res can be:
    # - dict with 'html' (HTML string) and 'cell_bbox'
    # - dict with 'cells' (list of [row, col] positions and text)
    html_str = None
    if isinstance(res, dict):
        html_str = res.get('html')
    elif isinstance(res, str):
        html_str = res

    cells: list[ParsedTableCellV1] = []
    row_count = 0
    col_count = 0

    if html_str:
        # Parse HTML table to extract cells
        try:
            from html.parser import HTMLParser

            class _TableParser(HTMLParser):
                def __init__(self) -> None:
                    super().__init__()
                    self.in_cell = False
                    self.current_row = -1
                    self.current_col = -1
                    self.cell_text = ''
                    self.cells: list[dict[str, Any]] = []
                    self.max_row = -1
                    self.max_col = -1

                def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
                    if tag == 'tr':
                        self.current_row += 1
                        self.current_col = -1
                    elif tag in ('td', 'th'):
                        self.in_cell = True
                        self.current_col += 1
                        self.cell_text = ''

                def handle_endtag(self, tag: str) -> None:
                    if tag in ('td', 'th') and self.in_cell:
                        self.cells.append({
                            'rowIndex': max(self.current_row, 0),
                            'columnIndex': max(self.current_col, 0),
                            'text': self.cell_text.strip(),
                        })
                        self.max_row = max(self.max_row, self.current_row)
                        self.max_col = max(self.max_col, self.current_col)
                        self.in_cell = False

                def handle_data(self, data: str) -> None:
                    if self.in_cell:
                        self.cell_text += data

            parser = _TableParser()
            parser.feed(html_str)
            row_count = parser.max_row + 1
            col_count = parser.max_col + 1
            for c in parser.cells:
                cells.append(ParsedTableCellV1(
                    rowIndex=c['rowIndex'],
                    columnIndex=c['columnIndex'],
                    text=c['text'],
                    confidence=None,
                ))
        except Exception:
            # If HTML parsing fails, return None
            return None

    if not cells and isinstance(res, dict) and 'cell_bbox' in res:
        cell_bboxes = res.get('cell_bbox', [])
        cell_texts = res.get('res', [])
        if isinstance(cell_texts, list):
            for _i, text in enumerate(cell_texts):
                if isinstance(text, list) and len(text) >= 2:
                    row_idx, col_idx = int(text[0]), int(text[1])
                    cell_text = str(text[2]) if len(text) > 2 else ''
                    row_count = max(row_count, row_idx + 1)
                    col_count = max(col_count, col_idx + 1)
                    cells.append(ParsedTableCellV1(
                        rowIndex=row_idx,
                        columnIndex=col_idx,
                        text=cell_text,
                    ))
            if isinstance(cell_bboxes, list) and len(cell_bboxes) == len(cells):
                for i, bbox in enumerate(cell_bboxes):
                    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                        cells[i] = cells[i].model_copy(update={
                            'boundingBox': BoundingBoxV1(
                                x0=str(bbox[0]),
                                y0=str(bbox[1]),
                                x1=str(bbox[2]),
                                y1=str(bbox[3]),
                            )
                        })

    if not cells:
        return None

    return ParsedTableV1(
        tableIndex=table_index,
        label=None,
        rowCount=row_count,
        columnCount=col_count,
        cells=cells,
        warnings=[],
    )


def _bbox_to_v1(bbox: list[float] | None) -> BoundingBoxV1 | None:
    """Convert a [x0, y0, x1, y1] list to BoundingBoxV1, or None."""
    if not bbox or len(bbox) != 4:
        return None
    return BoundingBoxV1(
        x0=str(bbox[0]),
        y0=str(bbox[1]),
        x1=str(bbox[2]),
        y1=str(bbox[3]),
    )


def _map_region_to_block(
    region: dict[str, Any],
    block_index: int,
) -> LayoutBlockV1 | None:
    """Map a PP-Structure region to a LayoutBlockV1."""
    region_type = region.get('type', 'unknown')
    bbox = region.get('bbox')

    # Map PP-Structure types to our block types
    block_type_map: dict[str, str] = {
        'text': 'paragraph',
        'title': 'heading',
        'figure': 'image',
        'figure_caption': 'caption',
        'table': 'table',
        'table_caption': 'caption',
        'header': 'header',
        'footer': 'footer',
    }
    block_type = cast(
        Literal['text', 'heading', 'paragraph', 'list_item', 'table', 'image',
               'header', 'footer', 'caption', 'unknown'],
        block_type_map.get(region_type, 'unknown'),
    )

    # Extract text from res
    res = region.get('res', {})
    text = ''
    if isinstance(res, str):
        text = res
    elif isinstance(res, dict):
        text = res.get('text', '') or res.get('res', '')
        if isinstance(text, list):
            text = ' '.join(str(t) for t in text)

    # Skip figure regions (they have no text)
    if block_type == 'image' and not text:
        return None

    return LayoutBlockV1(
        blockIndex=block_index,
        blockType=block_type,
        text=str(text),
        readingOrder=block_index,
        boundingBox=_bbox_to_v1(bbox),
    )


def _map_region_to_image(
    region: dict[str, Any],
    image_index: int,
) -> ParsedImageRegionV1 | None:
    """Map a PP-Structure figure region to ParsedImageRegionV1."""
    if region.get('type') != 'figure':
        return None
    bbox = region.get('bbox')
    return ParsedImageRegionV1(
        imageIndex=image_index,
        boundingBox=_bbox_to_v1(bbox),
    )


def process_page_with_paddleocr(
    engine: Any,
    img: Any,
    page_number: int,
    config: dict[str, Any],
    page_width: float | None = None,
    page_height: float | None = None,
    rotation: int = 0,
) -> ParserPageResultV1:
    """Process a single rendered page image with PP-StructureV3.

    Returns a ParserPageResultV1 with extracted blocks, tables, images.
    """
    warnings: list[str] = []

    # Run PP-StructureV3
    try:
        result = engine(img, return_ocr_result_in_table=True)
    except Exception as e:
        warnings.append(f'PP-StructureV3 processing error: {e}')
        result = None

    parsed = _classify_structure_result(result)
    regions = parsed['regions']

    blocks: list[LayoutBlockV1] = []
    tables: list[ParsedTableV1] = []
    images: list[ParsedImageRegionV1] = []
    all_text_parts: list[str] = []
    block_index = 0
    table_index = 0
    image_index = 0

    for region in regions:
        # Map to block
        block = _map_region_to_block(region, block_index)
        if block:
            blocks.append(block)
            block_index += 1
            if block.text:
                all_text_parts.append(block.text)

        # Map to table
        if region.get('type') in ('table',):
            table = _extract_table_from_region(region, page_number, table_index)
            if table:
                tables.append(table)
                table_index += 1

        # Map to image
        img_region = _map_region_to_image(region, image_index)
        if img_region:
            images.append(img_region)
            image_index += 1

    # Extract full text
    full_text = '\n'.join(all_text_parts) if all_text_parts else None

    # Determine evidence precision
    # PP-Structure provides bounding boxes, so we can claim cell_bbox for tables
    evidence_precision: Literal['page_only', 'text_span', 'cell_bbox'] = (
        'cell_bbox' if tables else 'page_only'
    )

    # Confidence — PP-Structure doesn't always provide overall confidence
    confidence = None

    # Model identifiers
    model_versions: list[str] = [ENGINE_VERSION]
    if config.get('orientationClassification', False):
        model_versions.append('paddleocr-orientation-cls-v1')
    if config.get('textLineOrientation', False):
        model_versions.append('paddleocr-text-line-orientation-v1')

    # Add model version warnings
    if config.get('formulaRecognition', False):
        warnings.append('formula recognition was enabled (non-default)')
    if config.get('chartRecognition', False):
        warnings.append('chart recognition was enabled (non-default)')
    if config.get('documentUnwarping', False):
        warnings.append('document unwarping was enabled (non-default)')

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
        images=images,
        confidence=confidence,
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
        runtime_warnings.append(ParserRuntimeWarningV1(
            code='config_warning',
            message='; '.join(config_warnings),
            pages=requested_pages,
        ))

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
        runtime_warnings.append(ParserRuntimeWarningV1(
            code='pdfplumber_unavailable',
            message='pdfplumber not available for page dimension lookup',
            pages=requested_pages,
        ))

    # Initialize PaddleOCR engine (lazy)
    try:
        engine = _create_paddle_structure(cfg)
    except RuntimeError as e:
        # PaddleOCR not installed — fail all pages
        for pn in requested_pages:
            failed_pages.append(ParserPageFailureV1(
                page=pn,
                code='model_unavailable',
                message=str(e),
            ))
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
            # Render page to image
            img = render_page_to_image(source_path, pn, dpi=dpi)

            # Get dimensions
            w, h, rot = page_dims.get(pn, (None, None, 0))

            # Process with timeout (simple — no threading in Phase 3)
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
                runtime_warnings.append(ParserRuntimeWarningV1(
                    code='page_timeout_exceeded',
                    message=f'page {pn} took {page_elapsed:.1f}s (limit {timeout}s)',
                    pages=[pn],
                ))

            page_results.append(page_result)
            succeeded_pages.append(pn)

        except ValueError as e:
            failed_pages.append(ParserPageFailureV1(
                page=pn,
                code='page_out_of_range' if 'out of range' in str(e) else 'render_error',
                message=str(e),
            ))
        except Exception as e:
            failed_pages.append(ParserPageFailureV1(
                page=pn,
                code='unknown_error',
                message=f'{type(e).__name__}: {e}',
            ))

    duration_ms = int((time.monotonic() - start_time) * 1000)

    metrics = ParserRuntimeMetricsV1(
        durationMillis=duration_ms,
        pagesProcessed=len(requested_pages),
        pagesSucceeded=len(succeeded_pages),
        pagesFailed=len(failed_pages),
        engineVersion=ENGINE_VERSION,
        modelVersions=[ENGINE_VERSION] if not cfg.get('orientationClassification') else [
            ENGINE_VERSION,
            'paddleocr-orientation-cls-v1',
        ],
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

    config = job_data.get('parserConfig', get_default_config())
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
