"""Deterministic provision reference, scope, directive, and deadline semantics."""

from __future__ import annotations

import re
from datetime import datetime

from .contracts import (
    BudgetComponentV1,
    ExplicitDateDeadlineV1,
    MilconProjectReferenceV1,
    OmSagReferenceV1,
    PeCodeReferenceV1,
    ProcurementReferenceV1,
    ProvisionActionTypeV1,
    ProvisionDeadlineV1,
    ProvisionReferenceV1,
    ProvisionScopeV1,
    RdteProjectReferenceV1,
    RelativeDeadlineV1,
    ReportingRecipientV1,
    TitleOnlyReferenceV1,
)

_PE_RE = re.compile(r'\b(?:PE|PROGRAM\s+ELEMENT)?\s*([0-9]{7}[A-Z])\b', re.IGNORECASE)
_PROJECT_WITH_PE_RE = re.compile(
    r'\bPROJECT\s+([A-Z0-9][A-Z0-9.-]{1,})\s+(?:UNDER|WITHIN|IN)\s+'
    r'(?:PE|PROGRAM\s+ELEMENT)\s*([0-9]{7}[A-Z])\b',
    re.IGNORECASE,
)
_PE_WITH_PROJECT_RE = re.compile(
    r'\b(?:PE|PROGRAM\s+ELEMENT)\s*([0-9]{7}[A-Z])\b[\s\S]{0,80}?'
    r'\bPROJECT\s+([A-Z0-9][A-Z0-9.-]{1,})\b',
    re.IGNORECASE,
)
_PROCUREMENT_RE = re.compile(
    r'\b(?:BLIN|LINE\s+ITEM)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b',
    re.IGNORECASE,
)
_OM_RE = re.compile(r'\b(?:SAG|SUBACTIVITY\s+GROUP)\s*[:#-]?\s*([A-Z0-9.]+)\b', re.IGNORECASE)
_MILCON_RE = re.compile(
    r'\b(?:MILCON\s+PROJECT|PROJECT(?:\s+(?:NO\.?|NUMBER))?|PN)\s*[:#-]?\s*'
    r'([A-Z0-9][A-Z0-9-]{2,})\b',
    re.IGNORECASE,
)
_ACCOUNT_RE = re.compile(r'\bACCOUNT\s*[:#-]?\s*([A-Z0-9.-]+)\b', re.IGNORECASE)
_LOCATION_RE = re.compile(r'\bLOCATION\s*[:#-]?\s*([^.;\n]+)', re.IGNORECASE)
_RELATIVE_DEADLINE_RE = re.compile(r'\bwithin\s+(\d{1,4})\s+days\b', re.IGNORECASE)
_DATE_DEADLINE_RE = re.compile(
    r'\b(?:not\s+later\s+than|by|on\s+or\s+before)\s+'
    r'((?:January|February|March|April|May|June|July|August|September|October|November|December)'
    r'\s+\d{1,2},\s+20\d{2})\b',
    re.IGNORECASE,
)
_RECIPIENT_PATTERNS = (
    re.compile(r'\bto\s+the\s+(congressional\s+defense\s+committees)\b', re.IGNORECASE),
    re.compile(r'\bto\s+the\s+(House\s+Committee\s+on\s+Armed\s+Services)\b', re.IGNORECASE),
    re.compile(r'\bto\s+the\s+(Senate\s+Committee\s+on\s+Armed\s+Services)\b', re.IGNORECASE),
    re.compile(r'\bto\s+the\s+(Committees\s+on\s+Armed\s+Services)\b', re.IGNORECASE),
)
_COMPONENT_PATTERNS: tuple[tuple[re.Pattern[str], BudgetComponentV1], ...] = (
    (re.compile(r'\bSPACE\s+FORCE\b', re.IGNORECASE), 'SF'),
    (re.compile(r'\bAIR\s+FORCE\b', re.IGNORECASE), 'AF'),
    (re.compile(r'\bMARINE\s+CORPS\b|\bUSMC\b', re.IGNORECASE), 'USMC'),
    (re.compile(r'\bNAVY\b', re.IGNORECASE), 'NAVY'),
    (re.compile(r'\bARMY\b', re.IGNORECASE), 'ARMY'),
    (re.compile(r'\bDEFENSE[- ]WIDE\b', re.IGNORECASE), 'DW'),
    (re.compile(r'\bDARPA\b', re.IGNORECASE), 'DARPA'),
    (re.compile(r'\bMISSILE\s+DEFENSE\s+AGENCY\b|\bMDA\b', re.IGNORECASE), 'MDA'),
    (re.compile(r'\bSOCOM\b|\bSPECIAL\s+OPERATIONS\s+COMMAND\b', re.IGNORECASE), 'SOCOM'),
)


def _extract_references(text: str, known_titles: list[str]) -> list[ProvisionReferenceV1]:
    references: list[ProvisionReferenceV1] = []
    seen: set[str] = set()

    for match in _PROJECT_WITH_PE_RE.finditer(text):
        project, pe_code = match.groups()
        _append_unique(
            references,
            seen,
            RdteProjectReferenceV1(peCode=pe_code.upper(), projectCode=project.upper()),
        )
    for match in _PE_WITH_PROJECT_RE.finditer(text):
        pe_code, project = match.groups()
        _append_unique(
            references,
            seen,
            RdteProjectReferenceV1(peCode=pe_code.upper(), projectCode=project.upper()),
        )

    project_pes = {ref.peCode for ref in references if isinstance(ref, RdteProjectReferenceV1)}
    for match in _PE_RE.finditer(text):
        pe_code = match.group(1).upper()
        if pe_code not in project_pes:
            _append_unique(references, seen, PeCodeReferenceV1(peCode=pe_code))

    component = _component(text)
    account_match = _ACCOUNT_RE.search(text)
    account = account_match.group(1).upper() if account_match is not None else None
    for match in _PROCUREMENT_RE.finditer(text):
        if account is not None and component is not None:
            _append_unique(
                references,
                seen,
                ProcurementReferenceV1(
                    code=match.group(1).upper(),
                    account=account,
                    component=component,
                    advanceProcurement='advance procurement' in text.lower(),
                ),
            )
    for match in _OM_RE.finditer(text):
        if account is not None and component is not None:
            _append_unique(
                references,
                seen,
                OmSagReferenceV1(code=match.group(1).upper(), account=account, component=component),
            )
    location_match = _LOCATION_RE.search(text)
    location = location_match.group(1).strip() if location_match is not None else None
    for match in _MILCON_RE.finditer(text):
        if component is not None:
            _append_unique(
                references,
                seen,
                MilconProjectReferenceV1(
                    projectCode=match.group(1).upper(),
                    component=component,
                    location=location,
                ),
            )

    normalized_haystack = _normalize_text(text)
    for title in known_titles:
        if _normalize_text(title) in normalized_haystack:
            _append_unique(references, seen, TitleOnlyReferenceV1(title=title))
    return references


def _append_unique(
    references: list[ProvisionReferenceV1], seen: set[str], value: ProvisionReferenceV1
) -> None:
    key = value.model_dump_json(exclude_none=True)
    if key not in seen:
        seen.add(key)
        references.append(value)


def _scope(text: str, references: list[ProvisionReferenceV1]) -> ProvisionScopeV1:
    normalized = _normalize_text(text)
    if any(
        phrase in normalized
        for phrase in ('department wide', 'departmentwide', 'across the department')
    ):
        return 'department_wide'
    if any(
        phrase in normalized for phrase in ('component wide', 'service wide', 'across the service')
    ):
        return 'component_wide'
    if any(phrase in normalized for phrase in ('account wide', 'across the account')):
        return 'account_wide'
    if any(phrase in normalized for phrase in ('program wide', 'across the program')):
        return 'program_wide'
    if any(isinstance(reference, RdteProjectReferenceV1) for reference in references):
        return 'project_specific'
    if any(
        isinstance(
            reference,
            (
                PeCodeReferenceV1,
                ProcurementReferenceV1,
                OmSagReferenceV1,
                MilconProjectReferenceV1,
            ),
        )
        for reference in references
    ):
        return 'line_specific'
    if any(isinstance(reference, TitleOnlyReferenceV1) for reference in references):
        return 'program_wide'
    return 'department_wide'


def _caveat(scope: str) -> str | None:
    values = {
        'program_wide': (
            'Program-wide language; do not attribute it to one budget line without review.'
        ),
        'account_wide': (
            'Account-wide language; do not attribute it to one budget line without review.'
        ),
        'component_wide': (
            'Component-wide language; do not attribute it to one budget line without review.'
        ),
        'department_wide': (
            'Department-wide language; do not attribute it to one budget line without review.'
        ),
    }
    return values.get(scope)


def _classify_action(text: str) -> ProvisionActionTypeV1:
    rules: tuple[tuple[ProvisionActionTypeV1, tuple[str, ...]], ...] = (
        ('directs_briefing', ('provide a briefing', 'deliver a briefing', 'shall brief')),
        (
            'directs_report',
            ('submit a report', 'provide a report', 'deliver a report', 'shall report'),
        ),
        ('adds', ('recommends an increase', 'additional $', 'increase of $')),
        ('cuts', ('recommends a decrease', 'recommends a reduction', 'reduction of $', 'descope')),
        ('transfers', ('transfer', 'realign')),
        ('restricts', ('none of the funds', 'limitation on', 'shall not be obligated', 'no funds')),
        ('encourages', ('encourages', 'urges the secretary', 'urges the department')),
        ('expresses_concern', ('remains concerned', 'notes with concern', 'concerned')),
    )
    normalized = text.lower()
    for action, phrases in rules:
        if any(phrase in normalized for phrase in phrases):
            return action
    return 'narrative'


def _deadline(text: str) -> ProvisionDeadlineV1 | None:
    date_match = _DATE_DEADLINE_RE.search(text)
    if date_match is not None:
        raw = date_match.group(0)
        parsed = datetime.strptime(date_match.group(1).title(), '%B %d, %Y').date()
        return ExplicitDateDeadlineV1(rawText=raw, isoDate=parsed.isoformat())
    relative_match = _RELATIVE_DEADLINE_RE.search(text)
    if relative_match is not None:
        return RelativeDeadlineV1(
            rawText=relative_match.group(0), days=int(relative_match.group(1))
        )
    return None


def _recipient(text: str) -> ReportingRecipientV1 | None:
    for pattern in _RECIPIENT_PATTERNS:
        match = pattern.search(text)
        if match is not None:
            raw = match.group(1)
            return ReportingRecipientV1(rawText=raw, normalized=_normalize_text(raw))
    return None


def _component(text: str) -> BudgetComponentV1 | None:
    for pattern, component in _COMPONENT_PATTERNS:
        if pattern.search(text):
            return component
    return None


def _normalize_text(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).strip()
