"""Phase 6 Workstream E — SASC deterministic extractor tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from capiro_defense_budget_parser.contracts import ParserPageResultV1
from capiro_defense_budget_parser.extractors.stages.sasc import extract_sasc_tables

FIXTURES = Path(__file__).parent / 'fixtures' / 'stages' / 'sasc'
SHA = 'a' * 64
PROFILE = 'fy2027-sasc-authorization-report'
SOURCE_DOCUMENT = 'source-sasc-fy2027'


def load_pages(name: str) -> list[ParserPageResultV1]:
    values = json.loads((FIXTURES / name).read_text())
    return [ParserPageResultV1.model_validate(value) for value in values]


def extract(name: str):
    return extract_sasc_tables(
        pages=load_pages(name),
        profile_id=PROFILE,
        source_document_id=SOURCE_DOCUMENT,
        source_sha256=SHA,
    )


def test_cross_page_continuation_uses_prior_identity_and_current_amount_page() -> None:
    result = extract('continuation.json')
    assert len(result.tables) == 1
    table = result.tables[0]
    row = table.rows[0]
    assert table.page == 41
    assert table.printedPage == 'S. Rept. 119-39, p. 213'
    assert row.reference.referenceKind == 'pe_code'
    assert row.reference.peCode == '0605053A'
    assert row.cells[1].value == '100000'
    assert row.cells[2].value == '25000'
    assert row.cells[3].value == '125000'
    assert row.finding == 'continued from physical page 40'
    assert any(
        'continued row from physical page 40 to 41' in warning for warning in result.warnings
    )


def test_repeated_senate_header_is_not_emitted_as_data() -> None:
    table = extract('continuation.json').tables[0]
    assert len(table.rows) == 1
    assert table.rows[0].rawLabel == 'PE 0605053A Ground Robotics'


def test_footnoted_senate_amounts_are_normalized_without_changing_semantics() -> None:
    table = extract('footnotes.json').tables[0]
    reference = table.rows[0].reference
    assert reference.referenceKind == 'procurement_line'
    assert reference.lineCode == 'W12002'
    assert reference.account == '2035A'
    assert reference.component == 'ARMY'
    assert table.rows[0].cells[1].value == '80000'
    assert table.rows[0].cells[2].value == '75000'
    assert table.columns[1].moneySemantic == 'request_baseline'
    assert table.columns[2].moneySemantic == 'recommended_total'


def test_senate_printed_page_convention_is_preserved_exactly() -> None:
    table = extract('footnotes.json').tables[0]
    assert table.printedPage == 'S. Rept. 119-39, p. 411'


def test_unsupported_unit_and_missing_account_remain_explicit() -> None:
    result = extract('edge-cases.json')
    table = result.tables[0]
    reference = table.rows[0].reference
    assert table.declaredUnit is None
    assert reference.referenceKind == 'procurement_line'
    assert reference.account is None
    assert any('unsupported printed unit billions' in warning for warning in result.warnings)


def test_json_output_uses_typescript_camel_case_contract() -> None:
    payload = extract('footnotes.json').model_dump(mode='json')
    table = payload['tables'][0]
    assert table['schemaVersion'] == 'congressional_table_v1'
    assert table['sourceDocumentId'] == SOURCE_DOCUMENT
    assert table['columns'][2]['moneySemantic'] == 'recommended_total'
    assert table['rows'][0]['reference']['referenceKind'] == 'procurement_line'
    assert 'source_document_id' not in table


def test_missing_page_fails_the_parser_runtime_contract() -> None:
    value = json.loads((FIXTURES / 'footnotes.json').read_text())[0]
    value.pop('page')
    with pytest.raises(ValidationError):
        ParserPageResultV1.model_validate(value)


def test_replay_is_deterministic() -> None:
    first = extract('continuation.json').model_dump_json()
    second = extract('continuation.json').model_dump_json()
    assert first == second


def test_extractor_has_no_paid_or_external_runtime_imports() -> None:
    source = (
        Path(__file__).parents[1]
        / 'src'
        / 'capiro_defense_budget_parser'
        / 'extractors'
        / 'stages'
        / 'sasc'
        / 'extractor.py'
    ).read_text()
    assert 'llamaparse' not in source.lower()
    assert 'boto3' not in source
    assert 'requests' not in source
    assert 'prisma' not in source.lower()
