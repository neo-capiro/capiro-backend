"""Deterministic, write-free SAC-D normalization for Phase 6 Workstream I.

Senate-specific behavior includes persistent account/component context across
split heading rows, cross-page continuation rows, repeated headers, and
footnoted amounts. No network, AWS, database, OCR, or paid-parser calls occur.
"""

from __future__ import annotations

from dataclasses import dataclass

from ....contracts import ParsedTableV1, ParserPageResultV1
from ..common.congressional_table import (
    BudgetLineReferenceV1,
    CongressionalCellV1,
    CongressionalRowV1,
    CongressionalTableV1,
    RowSemanticKindV1,
    StageExtractionResultV1,
)
from .semantics import (
    _LOCATION_RE,
    _account_from_text,
    _account_heading,
    _bbox,
    _canonical_decimal,
    _cells_for_row,
    _column_from_header,
    _component,
    _component_from_heading,
    _detect_unit,
    _header_semantic,
    _heading_candidates,
    _is_continuation_label,
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


@dataclass(frozen=True)
class _PendingContinuation:
    raw_label: str
    reference: BudgetLineReferenceV1
    semantic_kind: RowSemanticKindV1
    source_page: int


@dataclass(frozen=True)
class _PersistentContext:
    account: str | None = None
    component: str | None = None
    location: str | None = None
    line_family: str = 'unknown'


def extract_sacd_tables(
    *,
    pages: list[ParserPageResultV1],
    profile_id: str,
    source_document_id: str,
    source_sha256: str,
) -> StageExtractionResultV1:
    """Normalize SAC-D tables in physical-page order using Senate-specific state."""
    tables: list[CongressionalTableV1] = []
    warnings: list[str] = []
    omitted_pages: set[int] = set()
    pending: _PendingContinuation | None = None
    persistent = _PersistentContext()
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
        page_handled = False
        for parsed_table in sorted(page.tables, key=lambda item: item.tableIndex):
            normalized, table_warnings, pending, persistent, consumed = _normalize_table(
                page=page,
                parsed_table=parsed_table,
                profile_id=profile_id,
                source_document_id=source_document_id,
                source_sha256=source_sha256,
                pending=pending,
                persistent=persistent,
            )
            warnings.extend(f'page {page.page}: {message}' for message in table_warnings)
            page_handled = page_handled or consumed
            if normalized is not None:
                tables.append(normalized)
        if not page_handled:
            omitted_pages.add(page.page)

    if pending is not None:
        warnings.append(
            f'page {pending.source_page}: continuation lead has no following amount row'
        )
        omitted_pages.add(pending.source_page)

    return StageExtractionResultV1(
        stage='sac_d',
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
    pending: _PendingContinuation | None,
    persistent: _PersistentContext,
) -> tuple[
    CongressionalTableV1 | None,
    list[str],
    _PendingContinuation | None,
    _PersistentContext,
    bool,
]:
    warnings: list[str] = []
    matrix = _table_matrix(parsed_table)
    if not matrix:
        return None, ['empty table'], pending, persistent, False
    header_index = _find_header_row(matrix)
    if header_index is None:
        return (
            None,
            ['no header row with explicit SAC-D money or quantity semantics'],
            pending,
            persistent,
            False,
        )

    header = matrix[header_index]
    context = _table_context(page, parsed_table)
    line_family = _line_family(context, header)
    context_account = _account_from_text(context)
    context_component = _component(context)
    context_location = _match_group(_LOCATION_RE, context)
    persistent = _PersistentContext(
        account=context_account or persistent.account,
        component=context_component or persistent.component,
        location=context_location or persistent.location,
        line_family=line_family if line_family != 'unknown' else persistent.line_family,
    )

    unit, unit_warning = _detect_unit(' '.join([context, *header]))
    if unit_warning is not None:
        warnings.append(unit_warning)
    columns = [_column_from_header(index, text, unit) for index, text in enumerate(header)]
    if not any(column.moneySemantic is not None or column.isQuantity for column in columns):
        return (
            None,
            ['header has no supported money or quantity columns'],
            pending,
            persistent,
            False,
        )

    canonical_header = [_normalize_text(value) for value in header]
    rows: list[CongressionalRowV1] = []
    last_identity: tuple[str, BudgetLineReferenceV1, RowSemanticKindV1] | None = None
    consumed = False

    for source_row_index, raw_row in enumerate(
        matrix[header_index + 1 :],
        start=header_index + 1,
    ):
        if not any(value.strip() for value in raw_row):
            continue
        if [_normalize_text(value) for value in raw_row] == canonical_header:
            continue

        label_index = _label_column_index(columns)
        label = raw_row[label_index].strip() if label_index < len(raw_row) else ''
        source_cells = _cells_for_row(parsed_table, source_row_index)
        parsed_values = {
            column.columnIndex: _canonical_decimal(
                raw_row[column.columnIndex] if column.columnIndex < len(raw_row) else ''
            )
            for column in columns
            if column.moneySemantic is not None or column.isQuantity
        }
        has_value = any(value is not None for value in parsed_values.values())

        if not has_value and label:
            account_update = _account_heading(label)
            component_update = _component_from_heading(label)
            if account_update is not None or component_update is not None:
                persistent = _PersistentContext(
                    account=account_update or persistent.account,
                    component=component_update or persistent.component,
                    location=persistent.location,
                    line_family=persistent.line_family,
                )
                warnings.append(
                    f'split heading context: account={persistent.account or "unknown"}, '
                    f'component={persistent.component or "unknown"}'
                )
                consumed = True
                continue

        continuation = not label or _is_continuation_label(label)
        finding: str | None = None
        if continuation and has_value and pending is not None:
            raw_label = pending.raw_label
            reference = pending.reference
            semantic_kind = pending.semantic_kind
            finding = f'continued from physical page {pending.source_page}'
            warnings.append(
                f'continued row from physical page {pending.source_page} to {page.page}'
            )
            pending = None
        elif continuation and has_value and last_identity is not None:
            raw_label, reference, semantic_kind = last_identity
            finding = 'continued within Senate appropriations table'
        else:
            raw_label = label or next((value.strip() for value in raw_row if value.strip()), '')
            if not raw_label:
                continue
            semantic_kind = _row_semantic(raw_label)
            reference = _row_reference(
                raw_label=raw_label,
                line_family=persistent.line_family,
                account=persistent.account,
                component=persistent.component,
                location=persistent.location,
                semantic_kind=semantic_kind,
                context=context,
            )
            if not has_value and reference.referenceKind not in {
                'unresolved_reference',
                'package_scope',
            }:
                pending = _PendingContinuation(
                    raw_label=raw_label,
                    reference=reference,
                    semantic_kind=semantic_kind,
                    source_page=page.page,
                )
                consumed = True
                continue

        row_index = len(rows)
        cells: list[CongressionalCellV1] = []
        for column in columns:
            raw_text = raw_row[column.columnIndex] if column.columnIndex < len(raw_row) else ''
            cells.append(
                CongressionalCellV1(
                    rowIndex=row_index,
                    columnIndex=column.columnIndex,
                    rawText=raw_text,
                    value=parsed_values.get(column.columnIndex),
                    boundingBox=_bbox(source_cells.get(column.columnIndex)),
                )
            )

        if unit is None and any(cell.value is not None for cell in cells):
            prefix = f'{finding}; ' if finding else ''
            finding = f'{prefix}numeric row has no supported printed money unit'
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
        last_identity = (raw_label, reference, semantic_kind)
        consumed = True

    if not rows:
        warnings_for_empty = [] if consumed else ['table contains no complete data rows']
        return None, warnings_for_empty, pending, persistent, consumed
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
        pending,
        persistent,
        True,
    )


def _table_matrix(table: ParsedTableV1) -> list[list[str]]:
    matrix = [['' for _ in range(table.columnCount)] for _ in range(table.rowCount)]
    for cell in table.cells:
        if cell.rowIndex < table.rowCount and cell.columnIndex < table.columnCount:
            matrix[cell.rowIndex][cell.columnIndex] = cell.text.strip()
    return matrix


def _find_header_row(matrix: list[list[str]]) -> int | None:
    # Senate appropriations headers can span several rows before the data begins.
    for index, row in enumerate(matrix[:8]):
        if any(_header_semantic(value) is not None for value in row) or any(
            _is_quantity_header(value) for value in row
        ):
            return index
    return None
