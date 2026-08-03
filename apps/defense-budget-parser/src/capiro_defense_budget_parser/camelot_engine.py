"""capiro_defense_budget_parser.camelot_engine — second deterministic table parser.

Provides Camelot table parsing for digital pages where pdfplumber table
structure is insufficient. Supports lattice, stream, network, and hybrid
flavors. Preserves real table/cell geometry; never fabricates cell boxes.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

try:
    import camelot as _camelot_module  # type: ignore[import-not-found]
    camelot = _camelot_module
except ImportError:
    _camelot_module = None
    camelot = None

try:
    import pdfplumber as _pdfplumber_module  # noqa: F401 — for test patching
    pdfplumber = _pdfplumber_module
except ImportError:
    _pdfplumber_module = None  # type: ignore[assignment]
    pdfplumber = None  # type: ignore[assignment]

from .contracts import (
    BoundingBoxV1,
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

ENGINE_NAME = 'camelot'
ENGINE_VERSION = 'camelot-0.11.0'

# ------------------------------------------------------------------ #
# Supported flavors (G1)
# ------------------------------------------------------------------ #

CAMELOT_FLAVORS: dict[str, dict[str, Any]] = {
    'lattice': {
        'flavor': 'lattice',
        'default_kwargs': {},
    },
    'stream': {
        'flavor': 'stream',
        'default_kwargs': {},
    },
    'network': {
        'flavor': 'network',
        'default_kwargs': {},
    },
    'hybrid': {
        # hybrid = try lattice first, fallback to stream
        'flavor': 'hybrid',
        'default_kwargs': {},
    },
}

DEFAULT_FLAVOR = 'lattice'


def get_flavor_config(flavor_name: str) -> dict[str, Any]:
    if flavor_name not in CAMELOT_FLAVORS:
        raise ValueError(f'unknown Camelot flavor: {flavor_name}')
    return dict(CAMELOT_FLAVORS[flavor_name])


def build_default_config(flavor: str = DEFAULT_FLAVOR) -> dict[str, Any]:
    return {
        'flavor': flavor,
        'flavorConfig': get_flavor_config(flavor),
    }


def compute_config_sha256(config: dict[str, Any]) -> str:
    return compute_parser_config_sha256(config)


# ------------------------------------------------------------------ #
# Helpers
# ------------------------------------------------------------------ #


def _to_decimal_string(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return repr(value)


def _extract_cells_from_table(
    raw_table: Any,
    table_index: int,
) -> tuple[ParsedTableV1, dict[str, Any] | None]:
    """Extract a ParsedTableV1 from a Camelot table object.

    Returns (table, parser_report) where parser_report contains
    accuracy/whitespace/order/page metrics.
    """
    # Camelot tables have .df (pandas DataFrame), .cells, .bbox, etc.
    cells: list[ParsedTableCellV1] = []
    parser_report: dict[str, Any] | None = None

    # Get DataFrame
    try:
        df = raw_table.df
        row_count = len(df)
        col_count = len(df.columns)

        for r_idx in range(row_count):
            for c_idx in range(col_count):
                cell_text = str(df.iloc[r_idx, c_idx]).strip()

                # Real cell bounding box from Camelot's cell coordinates
                bbox = None
                try:
                    if hasattr(raw_table, 'cells') and raw_table.cells:
                        cell_key = (r_idx, c_idx)
                        # Camelot cells: dict of (row, col) -> (x1, y1, x2, y2)
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

                cells.append(ParsedTableCellV1(
                    rowIndex=r_idx,
                    columnIndex=c_idx,
                    text=cell_text,
                    boundingBox=bbox,
                ))
    except Exception:
        row_count = 0
        col_count = 0

    # Table bounding box
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

    # Parser report metrics (G3)
    try:
        parser_report = {
            'accuracy': getattr(raw_table, 'accuracy', None),
            'whitespace': getattr(raw_table, 'whitespace', None),
            'order': getattr(raw_table, 'order', None),
            'page': getattr(raw_table, 'page', None),
        }
        # Remove None values
        parser_report = {k: v for k, v in parser_report.items() if v is not None}
        if not parser_report:
            parser_report = None
    except Exception:
        parser_report = None

    table = ParsedTableV1(
        tableIndex=table_index,
        rowCount=row_count,
        columnCount=col_count,
        cells=cells,
        boundingBox=table_bbox,
        warnings=[],
    )

    return table, parser_report


def _run_camelot_single_flavor(
    source_path: str | Path,
    page_number: int,
    flavor: str,
    kwargs: dict[str, Any],
) -> list[Any]:
    """Run Camelot for a single page with a single flavor. Returns raw tables."""
    if camelot is None:
        raise ImportError('camelot is not installed')
    try:
        tables = camelot.read_pdf(
            str(source_path),
            pages=str(page_number),
            flavor=flavor,
            **kwargs,
        )
        return list(tables)
    except Exception:
        return []


def run_camelot_engine(
    source_path: str | Path,
    expected_sha256: str,
    requested_pages: list[int],
    config: dict[str, Any] | None = None,
    job_id: str = 'camelot-job',
) -> ParserRuntimeResultV1:
    """Run the Camelot engine on the requested pages."""
    cfg = config or build_default_config()
    config_sha = compute_config_sha256(cfg)

    # Source integrity
    verify_source_sha256(source_path, expected_sha256)
    actual_sha = compute_file_sha256(source_path)

    flavor = cfg.get('flavor', DEFAULT_FLAVOR)
    flavor_cfg = cfg.get('flavorConfig', get_flavor_config(flavor))
    flavor_name = flavor_cfg.get('flavor', flavor)
    flavor_kwargs = flavor_cfg.get('default_kwargs', {})

    start_time = time.monotonic()
    succeeded_pages: list[int] = []
    failed_pages: list[ParserPageFailureV1] = []
    page_results: list[ParserPageResultV1] = []
    runtime_warnings: list[ParserRuntimeWarningV1] = []

    # Check Camelot availability
    if camelot is None:
        for pn in requested_pages:
            failed_pages.append(ParserPageFailureV1(
                page=pn, code='model_unavailable',
                message='camelot is not installed',
            ))
        metrics = ParserRuntimeMetricsV1(
            durationMillis=0, pagesProcessed=len(requested_pages),
            pagesSucceeded=0, pagesFailed=len(requested_pages),
            engineVersion=ENGINE_VERSION,
        )
        return _build_result(
            job_id, config_sha, actual_sha, requested_pages,
            succeeded_pages, failed_pages, page_results,
            runtime_warnings, metrics,
        )

    # Get page dimensions from pdfplumber
    page_dims: dict[int, tuple[float, float, int]] = {}
    if pdfplumber is not None:
        try:
            with pdfplumber.open(str(source_path)) as pdf:
                for page in pdf.pages:
                    pn = int(page.page_number)
                    if pn in set(requested_pages):
                        page_dims[pn] = (
                            float(page.width),
                            float(page.height),
                            int(getattr(page, 'rotation', 0) or 0),
                        )
        except Exception:
            pass

    # Process each requested page
    for pn in requested_pages:
        w, h, rot = page_dims.get(pn, (0.0, 0.0, 0))

        try:
            raw_tables: list[Any] = []

            if flavor_name == 'hybrid':
                # G1: hybrid = try lattice first, fallback to stream
                raw_tables = _run_camelot_single_flavor(
                    source_path, pn, 'lattice', flavor_kwargs,
                )
                if not raw_tables:
                    raw_tables = _run_camelot_single_flavor(
                        source_path, pn, 'stream', flavor_kwargs,
                    )
            else:
                raw_tables = _run_camelot_single_flavor(
                    source_path, pn, flavor_name, flavor_kwargs,
                )

            if not raw_tables:
                # No tables found — check if this is a failure
                # A page with no table is not necessarily a failure (G6/G7)
                # Report as success with no tables if page exists
                tables: list[ParsedTableV1] = []
                warnings_list: list[str] = ['no tables detected on page']

                page_result = ParserPageResultV1(
                    page=pn,
                    width=_to_decimal_string(w) if w > 0 else None,
                    height=_to_decimal_string(h) if h > 0 else None,
                    rotation=rot if rot != 0 else None,
                    text=None,
                    markdown=None,
                    printedPage=None,
                    blocks=[],
                    tables=tables,
                    images=[],
                    evidencePrecision='page_only',
                    warnings=warnings_list,
                )
                page_results.append(page_result)
                succeeded_pages.append(pn)
                continue

            # Extract tables from Camelot results
            parsed_tables: list[ParsedTableV1] = []
            page_warnings: list[str] = []

            for t_idx, raw_table in enumerate(raw_tables):
                table, parser_report = _extract_cells_from_table(raw_table, t_idx)

                if table.rowCount == 0:
                    page_warnings.append(f'table {t_idx} has 0 rows — malformed')
                    continue

                parsed_tables.append(table)

                # G3: retain parser report as warning metadata
                if parser_report:
                    report_str = json_dumps_compact(parser_report)
                    page_warnings.append(f'table_{t_idx}_report:{report_str}')

            # Determine evidence precision (G4)
            has_cell_bbox = any(
                any(c.boundingBox is not None for c in t.cells)
                for t in parsed_tables
            )
            if has_cell_bbox:
                evidence_precision = 'cell_bbox'
            elif parsed_tables and any(t.boundingBox is not None for t in parsed_tables):
                evidence_precision = 'page_only'  # table bbox but no cell bbox
            else:
                evidence_precision = 'page_only'

            page_result = ParserPageResultV1(
                page=pn,
                width=_to_decimal_string(w) if w > 0 else None,
                height=_to_decimal_string(h) if h > 0 else None,
                rotation=rot if rot != 0 else None,
                text=None,
                markdown=None,
                printedPage=None,
                blocks=[],
                tables=parsed_tables,
                images=[],
                evidencePrecision=evidence_precision,  # type: ignore[arg-type]
                warnings=page_warnings,
            )
            page_results.append(page_result)
            succeeded_pages.append(pn)

        except Exception as e:
            failed_pages.append(ParserPageFailureV1(
                page=pn, code='pdf_parse_error',
                message=f'{type(e).__name__}: {e}',
            ))

    duration_ms = int((time.monotonic() - start_time) * 1000)

    metrics = ParserRuntimeMetricsV1(
        durationMillis=duration_ms,
        pagesProcessed=len(requested_pages),
        pagesSucceeded=len(succeeded_pages),
        pagesFailed=len(failed_pages),
        engineVersion=ENGINE_VERSION,
    )

    return _build_result(
        job_id, config_sha, actual_sha, requested_pages,
        succeeded_pages, failed_pages, page_results,
        runtime_warnings, metrics,
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


def json_dumps_compact(value: Any) -> str:
    import json

    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
