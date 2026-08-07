"""Deterministic, write-free HAC-D table normalization for Phase 6 Workstream H."""

from __future__ import annotations

from ....contracts import ParsedTableV1, ParserPageResultV1
from ..common.congressional_table import (
    CongressionalCellV1,
    CongressionalRowV1,
    CongressionalTableV1,
    StageExtractionResultV1,
)
from .semantics import (
    _ACCOUNT_RE,
    _LOCATION_RE,
    _bbox,
    _canonical_decimal,
    _cells_for_row,
    _column_from_header,
    _component,
    _detect_unit,
    _header_semantic,
    _heading_candidates,
    _is_quantity_header,
    _label_column_index,
    _line_family,
    _match_group,
    _normalize_text,
    _printed_page,
    _row_reference,
    _row_semantic,
    _table_context,
)


def extract_hacd_tables(
    *,
    pages: list[ParserPageResultV1],
    profile_id: str,
    source_document_id: str,
    source_sha256: str,
) -> StageExtractionResultV1:
    """Normalize HAC-D tables in physical-page order without external calls."""
    tables: list[CongressionalTableV1] = []
    warnings: list[str] = []
    omitted_pages: set[int] = set()
    ordered_pages = sorted(pages, key=lambda item: item.page)

    for previous, current in zip(ordered_pages, ordered_pages[1:], strict=False):
        if current.page > previous.page + 1:
            omitted_pages.update(range(previous.page + 1, current.page))
            warnings.append(
                f'physical pages {previous.page + 1}-{current.page - 1}: missing from parser result'
            )

    for page in ordered_pages:
        if not page.tables:
            omitted_pages.add(page.page)
            warnings.append(f'page {page.page}: no deterministic table detected')
            continue
        page_emitted = False
        for parsed_table in sorted(page.tables, key=lambda item: item.tableIndex):
            normalized, table_warnings = _normalize_table(
                page=page,
                parsed_table=parsed_table,
                profile_id=profile_id,
                source_document_id=source_document_id,
                source_sha256=source_sha256,
            )
            warnings.extend(f'page {page.page}: {message}' for message in table_warnings)
            if normalized is not None:
                tables.append(normalized)
                page_emitted = True
        if not page_emitted:
            omitted_pages.add(page.page)

    return StageExtractionResultV1(
        stage='hac_d',
        profileId=profile_id,
        sourceDocumentId=source_document_id,
        sourceSha256=source_sha256,
        tables=tables,
        warnings=warnings,
        omittedPages=sorted(omitted_pages),
    )


def _normalize_table(
    *,
    page: ParserPageResultV1,
    parsed_table: ParsedTableV1,
    profile_id: str,
    source_document_id: str,
    source_sha256: str,
) -> tuple[CongressionalTableV1 | None, list[str]]:
    warnings: list[str] = []
    matrix = _table_matrix(parsed_table)
    if not matrix:
        return None, ['empty table']
    header_index = _find_header_row(matrix)
    if header_index is None:
        return None, ['no header row with explicit HAC-D money or quantity semantics']

    header = matrix[header_index]
    context = _table_context(page, parsed_table)
    unit, unit_warning = _detect_unit(' '.join([context, *header]))
    if unit_warning is not None:
        warnings.append(unit_warning)
    columns = [_column_from_header(index, text, unit) for index, text in enumerate(header)]
    if not any(column.moneySemantic is not None or column.isQuantity for column in columns):
        return None, ['header has no supported money or quantity columns']

    line_family = _line_family(context, header)
    account = _match_group(_ACCOUNT_RE, context)
    component = _component(context)
    location = _match_group(_LOCATION_RE, context)
    canonical_header = [_normalize_text(value) for value in header]
    rows: list[CongressionalRowV1] = []

    for source_row_index, raw_row in enumerate(
        matrix[header_index + 1 :],
        start=header_index + 1,
    ):
        if not any(value.strip() for value in raw_row):
            continue
        if [_normalize_text(value) for value in raw_row] == canonical_header:
            continue
        label_index = _label_column_index(columns)
        raw_label = raw_row[label_index].strip() if label_index < len(raw_row) else ''
        if not raw_label:
            raw_label = next((value.strip() for value in raw_row if value.strip()), '')
        if not raw_label:
            continue

        semantic_kind = _row_semantic(raw_label)
        reference = _row_reference(
            raw_label=raw_label,
            line_family=line_family,
            account=account,
            component=component,
            location=location,
            semantic_kind=semantic_kind,
            context=context,
        )
        row_index = len(rows)
        source_cells = _cells_for_row(parsed_table, source_row_index)
        cells: list[CongressionalCellV1] = []
        for column in columns:
            raw_text = raw_row[column.columnIndex] if column.columnIndex < len(raw_row) else ''
            value = None
            if column.moneySemantic is not None or column.isQuantity:
                value = _canonical_decimal(raw_text)
            cells.append(
                CongressionalCellV1(
                    rowIndex=row_index,
                    columnIndex=column.columnIndex,
                    rawText=raw_text,
                    value=value,
                    boundingBox=_bbox(source_cells.get(column.columnIndex)),
                )
            )

        finding = None
        if unit is None and any(cell.value is not None for cell in cells):
            finding = 'numeric row has no supported printed money unit'
        rows.append(
            CongressionalRowV1(
                rowIndex=row_index,
                rawLabel=raw_label,
                reference=reference,
                semanticKind=semantic_kind,
                cells=cells,
                finding=finding,
            )
        )

    if not rows:
        return None, ['table contains no data rows after repeated-header removal']
    return (
        CongressionalTableV1(
            profileId=profile_id,
            sourceDocumentId=source_document_id,
            sourceSha256=source_sha256,
            page=page.page,
            printedPage=_printed_page(page.printedPage),
            headings=_heading_candidates(page, parsed_table),
            declaredUnit=unit,
            columns=columns,
            rows=rows,
        ),
        warnings,
    )


def _table_matrix(table: ParsedTableV1) -> list[list[str]]:
    matrix = [['' for _ in range(table.columnCount)] for _ in range(table.rowCount)]
    for cell in table.cells:
        if cell.rowIndex < table.rowCount and cell.columnIndex < table.columnCount:
            matrix[cell.rowIndex][cell.columnIndex] = cell.text.strip()
    return matrix


def _find_header_row(matrix: list[list[str]]) -> int | None:
    for index, row in enumerate(matrix[:6]):
        if any(_header_semantic(value) is not None for value in row) or any(
            _is_quantity_header(value) for value in row
        ):
            return index
    return None
