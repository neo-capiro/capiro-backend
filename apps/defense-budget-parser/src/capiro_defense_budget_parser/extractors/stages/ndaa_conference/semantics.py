"""Deterministic NDAA conference table and chamber-disposition semantics."""

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
    PeCodeReferenceV1,
    ProcurementReferenceV1,
    RowSemanticKindV1,
    UnresolvedReferenceV1,
)
from .contracts import (
    ConferenceColumnRoleV1,
    ConferenceDispositionChamberV1,
    ConferenceDispositionTypeV1,
    NdaaConferenceChamberDispositionV1,
)

_PE_RE = re.compile(r'\b([0-9]{7}[A-Z])\b', re.IGNORECASE)
_PROCUREMENT_RE = re.compile(
    r'\b(?:BLIN|LINE(?:\s+ITEM)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b', re.IGNORECASE
)
_OM_RE = re.compile(r'\b(?:SAG|SUBACTIVITY\s+GROUP)\s*[:#-]?\s*([A-Z0-9.]+)\b', re.IGNORECASE)
_MILCON_RE = re.compile(
    r'\b(?:PROJECT(?:\s+(?:NO\.?|NUMBER))?|PN)\s*[:#-]?\s*([A-Z0-9-]+)\b', re.IGNORECASE
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


def column_role_and_semantic(
    header: str,
) -> tuple[ConferenceColumnRoleV1, MoneySemanticV1 | None, bool]:
    normalized = normalize_text(header)
    if not normalized:
        return 'other', None, False
    if 'quantity' in normalized or normalized in {'qty'}:
        return 'quantity', None, True
    if 'house' in normalized and any(
        token in normalized
        for token in ('position', 'authorized', 'authorization', 'recommendation')
    ):
        return 'hasc', 'authorized_total', False
    if 'senate' in normalized and any(
        token in normalized
        for token in ('position', 'authorized', 'authorization', 'recommendation')
    ):
        return 'sasc', 'authorized_total', False
    if any(token in normalized for token in ('conference', 'agreement')) and any(
        token in normalized
        for token in ('position', 'authorized', 'authorization', 'agreement', 'total')
    ):
        return 'ndaa_conference', 'authorized_total', False
    if 'request' in normalized or 'budget estimate' in normalized:
        return 'request_baseline', 'request_baseline', False
    if 'change' in normalized or 'adjustment' in normalized:
        return 'change', 'change', False
    if any(token in normalized for token in ('program element', 'line', 'sag', 'project', 'item')):
        return 'label', None, False
    return 'other', None, False


def column_from_header(
    index: int, header: str, table_unit: MoneyUnitV1 | None
) -> tuple[CongressionalColumnV1, ConferenceColumnRoleV1]:
    role, semantic, is_quantity = column_role_and_semantic(header)
    column_unit, _ = detect_unit(header)
    return (
        CongressionalColumnV1(
            columnIndex=index,
            headerText=header or f'column-{index}',
            moneySemantic=semantic,
            fiscalYear=fiscal_year(header),
            declaredUnit=column_unit if column_unit != table_unit else None,
            isQuantity=is_quantity,
        ),
        role,
    )


def row_semantic(label: str) -> RowSemanticKindV1:
    normalized = normalize_text(label)
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
    if any(token in normalized for token in ('increase', 'decrease', 'reduction', 'adjustment')):
        return 'adjustment'
    return 'absolute_position'


def row_reference(
    *,
    raw_label: str,
    line_family: str,
    account: str | None,
    component: str | None,
    location: str | None,
) -> BudgetLineReferenceV1:
    pe_match = _PE_RE.search(raw_label)
    if pe_match is not None:
        return PeCodeReferenceV1(peCode=pe_match.group(1).upper(), rowTitle=raw_label)
    procurement_match = _PROCUREMENT_RE.search(raw_label)
    if procurement_match is not None or line_family == 'procurement':
        code = (
            procurement_match.group(1).upper()
            if procurement_match is not None
            else first_code(raw_label)
        )
        if code is not None:
            return ProcurementReferenceV1(
                lineCode=code,
                account=account,
                component=component,
                advanceProcurement='advance procurement' in normalize_text(raw_label),
                rowTitle=raw_label,
            )
    om_match = _OM_RE.search(raw_label)
    if om_match is not None or line_family == 'om':
        code = om_match.group(1).upper() if om_match is not None else first_code(raw_label)
        if code is not None:
            return OmSagReferenceV1(
                sagCode=code,
                account=account,
                component=component,
                rowTitle=raw_label,
            )
    milcon_match = _MILCON_RE.search(raw_label)
    if milcon_match is not None or line_family == 'milcon':
        code = milcon_match.group(1).upper() if milcon_match is not None else first_code(raw_label)
        if code is not None:
            return MilconReferenceV1(
                projectCode=code,
                component=component,
                location=location,
                rowTitle=raw_label,
            )
    return UnresolvedReferenceV1(rawText=raw_label)


def line_family(context: str, header: list[str]) -> str:
    normalized = normalize_text(' '.join([context, *header]))
    if 'military construction' in normalized or 'milcon' in normalized:
        return 'milcon'
    if (
        'operation and maintenance' in normalized
        or 'o m' in normalized
        or ' sag ' in f' {normalized} '
    ):
        return 'om'
    if 'procurement' in normalized or 'blin' in normalized:
        return 'procurement'
    if 'research development test and evaluation' in normalized or 'r d t e' in normalized:
        return 'rdte'
    return 'unknown'


def detect_unit(text: str) -> tuple[MoneyUnitV1 | None, str | None]:
    normalized = normalize_text(text)
    if 'billion' in normalized:
        return None, 'unsupported printed unit billions; no magnitude inference performed'
    if 'million' in normalized:
        return 'millions', None
    if 'thousand' in normalized:
        return 'thousands', None
    if 'dollar' in normalized or '$' in text:
        return 'dollars', None
    return None, None


def fiscal_year(text: str) -> int | None:
    match = _FY_RE.search(text)
    if match is None:
        return None
    raw = int(match.group(1))
    return raw if raw >= 1900 else 2000 + raw


def canonical_decimal(text: str) -> str | None:
    value = text.strip().replace('$', '').replace(',', '')
    if value in {'', '-', '—', '–', 'N/A', 'n/a'}:
        return None
    negative = value.startswith('(') and value.endswith(')')
    if negative:
        value = value[1:-1].strip()
    value = re.sub(r'(?<=\d)(?:[a-z*†‡]+|\([a-z0-9]+\))$', '', value, flags=re.IGNORECASE)
    value = value.strip()
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


def table_context(page: ParserPageResultV1, table: ParsedTableV1) -> str:
    values = [table.label or '', page.text or '']
    values.extend(
        block.text for block in page.blocks if block.blockType in {'heading', 'header', 'caption'}
    )
    return '\n'.join(value for value in values if value)


def heading_candidates(page: ParserPageResultV1, table: ParsedTableV1) -> list[str]:
    headings = [table.label] if table.label else []
    headings.extend(
        block.text for block in page.blocks if block.blockType in {'heading', 'header', 'caption'}
    )
    return list(dict.fromkeys(value.strip() for value in headings if value and value.strip()))


def component(context: str) -> str | None:
    for pattern, value in _COMPONENTS:
        if pattern.search(context):
            return value
    explicit = re.search(r'\bCOMPONENT\s*:\s*([A-Z]+)', context, re.IGNORECASE)
    return explicit.group(1).upper() if explicit is not None else None


def account(context: str) -> str | None:
    match = _ACCOUNT_RE.search(context)
    return match.group(1).strip() if match is not None else None


def location(context: str) -> str | None:
    match = _LOCATION_RE.search(context)
    return match.group(1).strip() if match is not None else None


def first_code(label: str) -> str | None:
    for match in re.finditer(r'\b([A-Z0-9][A-Z0-9.-]{1,})\b', label, re.IGNORECASE):
        token = match.group(1)
        if any(character.isdigit() for character in token):
            return token.upper()
    return None


def label_column_index(
    columns: list[CongressionalColumnV1], roles: list[ConferenceColumnRoleV1]
) -> int:
    for column, role in zip(columns, roles, strict=True):
        if role == 'label':
            return column.columnIndex
    for column in columns:
        if column.moneySemantic is None and not column.isQuantity:
            return column.columnIndex
    return 0


def cells_for_row(table: ParsedTableV1, row_index: int) -> dict[int, ParsedTableCellV1]:
    return {cell.columnIndex: cell for cell in table.cells if cell.rowIndex == row_index}


def bbox(cell: ParsedTableCellV1 | None) -> BoundingBoxV1 | None:
    if cell is None or cell.boundingBox is None:
        return None
    return BoundingBoxV1(
        x0=cell.boundingBox.x0,
        y0=cell.boundingBox.y0,
        x1=cell.boundingBox.x1,
        y1=cell.boundingBox.y1,
    )


def normalize_text(value: str) -> str:
    return re.sub(r'[^a-z0-9$]+', ' ', value.lower()).strip()


def chamber_dispositions(text: str) -> list[NdaaConferenceChamberDispositionV1]:
    """Extract only explicit chamber-disposition phrases; no fuzzy inference."""
    patterns: tuple[
        tuple[re.Pattern[str], ConferenceDispositionChamberV1, ConferenceDispositionTypeV1], ...
    ] = (
        (re.compile(r'\bthe\s+house\s+recedes\b', re.IGNORECASE), 'house', 'receded'),
        (re.compile(r'\bthe\s+senate\s+recedes\b', re.IGNORECASE), 'senate', 'receded'),
        (
            re.compile(
                r'\bconference\s+agreement\s+adopts?\s+the\s+house\s+(?:provision|position)\b',
                re.IGNORECASE,
            ),
            'house',
            'adopted',
        ),
        (
            re.compile(
                r'\bconference\s+agreement\s+adopts?\s+the\s+senate\s+(?:provision|position)\b',
                re.IGNORECASE,
            ),
            'senate',
            'adopted',
        ),
        (
            re.compile(
                r'\bconference\s+agreement\s+does\s+not\s+adopt\s+the\s+house\s+(?:provision|position)\b',
                re.IGNORECASE,
            ),
            'house',
            'not_adopted',
        ),
        (
            re.compile(
                r'\bconference\s+agreement\s+does\s+not\s+adopt\s+the\s+senate\s+(?:provision|position)\b',
                re.IGNORECASE,
            ),
            'senate',
            'not_adopted',
        ),
        (
            re.compile(r'\bconferees\s+agree\b', re.IGNORECASE),
            'both',
            'agreed',
        ),
        (
            re.compile(r'\bconference\s+agreement\s+modifies?\b', re.IGNORECASE),
            'both',
            'modified',
        ),
    )
    out: list[NdaaConferenceChamberDispositionV1] = []
    seen: set[tuple[str, str, str]] = set()
    for pattern, chamber, disposition in patterns:
        for match in pattern.finditer(text):
            raw = match.group(0)
            key = (chamber, disposition, raw.lower())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                NdaaConferenceChamberDispositionV1(
                    chamber=chamber,
                    disposition=disposition,
                    rawText=raw,
                )
            )
    return out
