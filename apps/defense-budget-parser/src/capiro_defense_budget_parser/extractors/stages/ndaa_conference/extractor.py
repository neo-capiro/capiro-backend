"""Deterministic NDAA conference table normalization.

Consumes parser-runtime pages already produced locally. It preserves printed
House/Senate/Conference column roles as a sidecar over the shared
CongressionalTableV1 contract. No network, AWS, database, OCR, or paid-parser
call is made here.
"""

from __future__ import annotations

from ....contracts import ParsedTableV1, ParserPageResultV1
from ..common.congressional_table import (
    CongressionalCellV1,
    CongressionalRowV1,
    CongressionalTableV1,
)
from .contracts import (
    NdaaConferenceColumnRoleV1,
    NdaaConferenceExtractionResultV1,
    NdaaConferenceTableV1,
)
from .semantics import (
    account,
    bbox,
    canonical_decimal,
    cells_for_row,
    column_from_header,
    component,
    detect_unit,
    heading_candidates,
    label_column_index,
    line_family,
    location,
    normalize_text,
    row_reference,
    row_semantic,
    table_context,
)


def extract_ndaa_conference_tables(
    *,
    pages: list[ParserPageResultV1],
    profile_id: str,
    source_document_id: str,
    source_sha256: str,
) -> NdaaConferenceExtractionResultV1:
    tables: list[NdaaConferenceTableV1] = []
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
            warnings.append(f'page {page.page}: no deterministic conference table detected')
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
            warnings.extend(f'page {page.page}: {warning}' for warning in table_warnings)
            if normalized is not None:
                tables.append(normalized)
                page_emitted = True
        if not page_emitted:
            omitted_pages.add(page.page)

    return NdaaConferenceExtractionResultV1(
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
) -> tuple[NdaaConferenceTableV1 | None, list[str]]:
    warnings: list[str] = []
    matrix = _table_matrix(parsed_table)
    if not matrix:
        return None, ['empty table']
    header_index = _find_header_row(matrix)
    if header_index is None:
        return None, ['no header row with explicit conference money semantics']
    header = matrix[header_index]
    context = table_context(page, parsed_table)
    unit, unit_warning = detect_unit(' '.join([context, *header]))
    if unit_warning is not None:
        warnings.append(unit_warning)

    columns = []
    roles = []
    for index, text in enumerate(header):
        column, role = column_from_header(index, text, unit)
        columns.append(column)
        roles.append(role)
    if 'ndaa_conference' not in roles and 'change' not in roles:
        return None, ['header has no explicit Conference/Agreement total or change column']

    family = line_family(context, header)
    row_account = account(context)
    row_component = component(context)
    row_location = location(context)
    label_index = label_column_index(columns, roles)
    canonical_header = [normalize_text(value) for value in header]
    rows: list[CongressionalRowV1] = []

    for source_row_index, raw_row in enumerate(matrix[header_index + 1 :], start=header_index + 1):
        if not any(value.strip() for value in raw_row):
            continue
        if [normalize_text(value) for value in raw_row] == canonical_header:
            continue
        raw_label = raw_row[label_index].strip() if label_index < len(raw_row) else ''
        if not raw_label:
            raw_label = next((value.strip() for value in raw_row if value.strip()), '')
        if not raw_label:
            continue

        semantic_kind = row_semantic(raw_label)
        reference = row_reference(
            raw_label=raw_label,
            line_family=family,
            account=row_account,
            component=row_component,
            location=row_location,
        )
        row_index = len(rows)
        source_cells = cells_for_row(parsed_table, source_row_index)
        cells: list[CongressionalCellV1] = []
        for column in columns:
            raw_text = raw_row[column.columnIndex] if column.columnIndex < len(raw_row) else ''
            value = None
            if column.moneySemantic is not None or column.isQuantity:
                value = canonical_decimal(raw_text)
            cells.append(
                CongressionalCellV1(
                    rowIndex=row_index,
                    columnIndex=column.columnIndex,
                    rawText=raw_text,
                    value=value,
                    boundingBox=bbox(source_cells.get(column.columnIndex)),
                )
            )
        finding = None
        if unit is None and any(
            cell.value is not None
            for cell in cells
            if columns[cell.columnIndex].moneySemantic is not None
        ):
            finding = 'numeric conference row has no supported printed money unit'
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

    table = CongressionalTableV1(
        profileId=profile_id,
        sourceDocumentId=source_document_id,
        sourceSha256=source_sha256,
        page=page.page,
        printedPage=page.printedPage,
        headings=heading_candidates(page, parsed_table),
        declaredUnit=unit,
        columns=columns,
        rows=rows,
    )
    return (
        NdaaConferenceTableV1(
            table=table,
            columnRoles=[
                NdaaConferenceColumnRoleV1(columnIndex=index, role=role)
                for index, role in enumerate(roles)
            ],
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
    from .semantics import column_role_and_semantic

    for index, row in enumerate(matrix[:4]):
        roles = [column_role_and_semantic(value)[0] for value in row]
        if 'ndaa_conference' in roles or ('change' in roles and 'request_baseline' in roles):
            return index
    return None
