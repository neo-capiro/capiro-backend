"""Senate-specific semantics for SASC table normalization."""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

from ....contracts import ParsedTableCellV1, ParsedTableV1, ParserPageResultV1
from ..common.congressional_table import (
    BoundingBoxV1,
    BudgetLineReferenceV1,
    CongressionalColumnV1,
    MilconReferenceV1,
    MoneySemanticV1,
    MoneyUnitV1,
    OmSagReferenceV1,
    PackageScopeReferenceV1,
    PeCodeReferenceV1,
    ProcurementReferenceV1,
    RowSemanticKindV1,
    UnresolvedReferenceV1,
)

_PE_RE = re.compile(r'\b([0-9]{7}[A-Z])\b', re.IGNORECASE)
_PROCUREMENT_RE = re.compile(
    r'\b(?:BLIN|LINE(?:\s+ITEM)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b',
    re.IGNORECASE,
)
_OM_RE = re.compile(
    r'\b(?:SAG|SUBACTIVITY\s+GROUP)\s*[:#-]?\s*([A-Z0-9.]+)\b',
    re.IGNORECASE,
)
_MILCON_RE = re.compile(
    r'\b(?:PROJECT(?:\s+(?:NO\.?|NUMBER))?|PN)\s*[:#-]?\s*([A-Z0-9-]+)\b',
    re.IGNORECASE,
)
_FY_RE = re.compile(r'\bFY\s*(20\d{2}|\d{2})\b', re.IGNORECASE)
_ACCOUNT_RE = re.compile(r'\bACCOUNT\s*:\s*([^|\n]+)', re.IGNORECASE)
_LOCATION_RE = re.compile(r'\bLOCATION\s*:\s*([^|\n]+)', re.IGNORECASE)

_COMPONENTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r'\bSPACE\s+FORCE\b', re.IGNORECASE), 'SF'),
    (re.compile(r'\bAIR\s+FORCE\b', re.IGNORECASE), 'AF'),
    (re.compile(r'\bMARINE\s+CORPS\b|\bUSMC\b', re.IGNORECASE), 'USMC'),
    (re.compile(r'\bNAVY\b', re.IGNORECASE), 'NAVY'),
    (re.compile(r'\bARMY\b', re.IGNORECASE), 'ARMY'),
    (re.compile(r'\bDEFENSE[- ]WIDE\b', re.IGNORECASE), 'DW'),
)


def _normalize_text(value: str) -> str:
    return re.sub(r'[^a-z0-9$]+', ' ', value.lower()).strip()


def _header_semantic(value: str) -> MoneySemanticV1 | None:
    """Bind Senate column meaning from printed header text only."""
    normalized = _normalize_text(value)
    if not normalized:
        return None
    if 'budget estimate' in normalized or 'request' in normalized:
        return 'request_baseline'
    if 'rescission' in normalized:
        return 'rescission_amount'
    if 'transfer' in normalized:
        return 'transfer_amount'
    if 'change' in normalized or 'adjustment' in normalized:
        return 'change'
    if any(
        token in normalized
        for token in (
            'senate recommendation',
            'sasc recommendation',
            'committee recommendation',
            'senate authorized',
        )
    ) or normalized in {'recommended', 'authorized'}:
        return 'recommended_total'
    return None


def _is_quantity_header(value: str) -> bool:
    normalized = _normalize_text(value)
    return 'quantity' in normalized or normalized in {'qty', 'qty.'}


def _fiscal_year(value: str) -> int | None:
    match = _FY_RE.search(value)
    if match is None:
        return None
    raw = int(match.group(1))
    return raw if raw >= 1900 else 2000 + raw


def _detect_unit(value: str) -> tuple[MoneyUnitV1 | None, str | None]:
    normalized = _normalize_text(value)
    if 'billion' in normalized:
        return None, 'unsupported printed unit billions; no magnitude inference performed'
    if 'million' in normalized:
        return 'millions', None
    if 'thousand' in normalized:
        return 'thousands', None
    if 'dollar' in normalized or '$' in value:
        return 'dollars', None
    return None, None


def _column_from_header(
    index: int,
    header: str,
    table_unit: str | None,
) -> CongressionalColumnV1:
    quantity = _is_quantity_header(header)
    semantic = None if quantity else _header_semantic(header)
    column_unit, _ = _detect_unit(header)
    return CongressionalColumnV1(
        columnIndex=index,
        headerText=header or f'column-{index}',
        moneySemantic=semantic,
        fiscalYear=_fiscal_year(header),
        declaredUnit=column_unit if column_unit != table_unit else None,
        isQuantity=quantity,
    )


def _canonical_decimal(text: str) -> str | None:
    """Normalize Senate numeric cells while removing printed footnote markers."""
    value = text.strip().replace('$', '').replace(',', '')
    if value in {'', '-', '—', '–', 'N/A', 'n/a'}:
        return None

    negative = value.startswith('(') and value.endswith(')') and re.search(r'\d', value) is not None
    if negative:
        value = value[1:-1].strip()

    # Senate tables commonly use 125a, 125*, 125†, or 125(a).
    value = re.sub(r'(?:\([a-z0-9]+\)|[a-z*†‡]+)$', '', value, flags=re.IGNORECASE).strip()
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        return None
    if negative:
        parsed = -abs(parsed)
    if parsed == 0:
        return '0'

    rendered = format(parsed, 'f')
    if '.' in rendered:
        rendered = rendered.rstrip('0').rstrip('.')
    return rendered.lstrip('+')


def _row_semantic(label: str) -> RowSemanticKindV1:
    normalized = _normalize_text(label)
    if 'transfer in' in normalized:
        return 'transfer_in'
    if 'transfer out' in normalized:
        return 'transfer_out'
    if 'rescission' in normalized:
        return 'rescission'
    if 'undistributed' in normalized:
        return 'undistributed'
    if 'general provision' in normalized:
        return 'general_provision'
    if 'quantity' in normalized and any(
        token in normalized for token in ('change', 'increase', 'decrease')
    ):
        return 'quantity_change'
    if any(token in normalized for token in ('increase', 'decrease', 'reduction', 'adjustment')):
        return 'adjustment'
    return 'absolute_position'


def _first_code(label: str) -> str | None:
    for match in re.finditer(r'\b([A-Z0-9][A-Z0-9.-]{1,})\b', label, re.IGNORECASE):
        token = match.group(1)
        if any(character.isdigit() for character in token):
            return token.upper()
    return None


def _package_scope(context: str) -> str:
    for line in context.splitlines():
        if any(
            token in _normalize_text(line)
            for token in (
                'title ',
                'research',
                'procurement',
                'operation',
                'military construction',
            )
        ):
            return line.strip()
    return 'SASC report package'


def _row_reference(
    *,
    raw_label: str,
    line_family: str,
    account: str | None,
    component: str | None,
    location: str | None,
    semantic_kind: str,
    context: str,
) -> BudgetLineReferenceV1:
    if semantic_kind in {'general_provision', 'undistributed'} and not any(
        pattern.search(raw_label) for pattern in (_PE_RE, _PROCUREMENT_RE, _OM_RE, _MILCON_RE)
    ):
        return PackageScopeReferenceV1(scope=_package_scope(context), rowTitle=raw_label)

    pe_match = _PE_RE.search(raw_label)
    if pe_match is not None:
        return PeCodeReferenceV1(peCode=pe_match.group(1).upper(), rowTitle=raw_label)

    procurement_match = _PROCUREMENT_RE.search(raw_label)
    if procurement_match is not None or line_family == 'procurement':
        code = (
            procurement_match.group(1).upper()
            if procurement_match is not None
            else _first_code(raw_label)
        )
        if code is not None:
            return ProcurementReferenceV1(
                lineCode=code,
                account=account,
                component=component,
                advanceProcurement='advance procurement' in _normalize_text(raw_label),
                rowTitle=raw_label,
            )

    om_match = _OM_RE.search(raw_label)
    if om_match is not None or line_family == 'om':
        code = om_match.group(1).upper() if om_match is not None else _first_code(raw_label)
        if code is not None:
            return OmSagReferenceV1(
                sagCode=code,
                account=account,
                component=component,
                rowTitle=raw_label,
            )

    milcon_match = _MILCON_RE.search(raw_label)
    if milcon_match is not None or line_family == 'milcon':
        code = milcon_match.group(1).upper() if milcon_match is not None else _first_code(raw_label)
        if code is not None:
            return MilconReferenceV1(
                projectCode=code,
                component=component,
                location=location,
                rowTitle=raw_label,
            )

    return UnresolvedReferenceV1(rawText=raw_label)


def _line_family(context: str, header: list[str]) -> str:
    normalized = _normalize_text(' '.join([context, *header]))
    if 'military construction' in normalized or 'milcon' in normalized:
        return 'milcon'
    if (
        'operation and maintenance' in normalized
        or 'o&m' in normalized
        or ' sag ' in f' {normalized} '
    ):
        return 'om'
    if 'procurement' in normalized or 'blin' in normalized:
        return 'procurement'
    if 'research development test and evaluation' in normalized or 'r d t e' in normalized:
        return 'rdte'
    return 'unknown'


def _table_context(page: ParserPageResultV1, table: ParsedTableV1) -> str:
    values = [table.label or '', page.text or '']
    values.extend(
        block.text for block in page.blocks if block.blockType in {'heading', 'header', 'caption'}
    )
    return '\n'.join(value for value in values if value)


def _heading_candidates(page: ParserPageResultV1, table: ParsedTableV1) -> list[str]:
    headings = [table.label] if table.label else []
    headings.extend(
        block.text for block in page.blocks if block.blockType in {'heading', 'header', 'caption'}
    )
    return list(dict.fromkeys(value.strip() for value in headings if value and value.strip()))


def _component(context: str) -> str | None:
    for pattern, component in _COMPONENTS:
        if pattern.search(context):
            return component
    explicit = re.search(r'\bCOMPONENT\s*:\s*([A-Z]+)', context, re.IGNORECASE)
    return explicit.group(1).upper() if explicit is not None else None


def _match_group(pattern: re.Pattern[str], value: str) -> str | None:
    match = pattern.search(value)
    return match.group(1).strip() if match is not None else None


def _label_column_index(columns: list[CongressionalColumnV1]) -> int:
    for column in columns:
        if column.moneySemantic is None and not column.isQuantity:
            return column.columnIndex
    return 0


def _cells_for_row(table: ParsedTableV1, row_index: int) -> dict[int, ParsedTableCellV1]:
    return {cell.columnIndex: cell for cell in table.cells if cell.rowIndex == row_index}


def _bbox(cell: ParsedTableCellV1 | None) -> BoundingBoxV1 | None:
    if cell is None or cell.boundingBox is None:
        return None
    return BoundingBoxV1(
        x0=cell.boundingBox.x0,
        y0=cell.boundingBox.y0,
        x1=cell.boundingBox.x1,
        y1=cell.boundingBox.y1,
    )


def _is_continuation_label(label: str) -> bool:
    normalized = _normalize_text(label)
    return normalized in {'continued', 'continuation', 'cont d', 'cont'} or normalized.endswith(
        ' continued'
    )


def _printed_page(value: str | None) -> str | None:
    """Preserve Senate report-page conventions while normalizing whitespace."""
    if value is None:
        return None
    normalized = re.sub(r'\s+', ' ', value).strip()
    return normalized or None
