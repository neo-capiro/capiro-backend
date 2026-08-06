"""Phase 6 Workstream D — HASC deterministic extractor tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from capiro_defense_budget_parser.contracts import ParserPageResultV1
from capiro_defense_budget_parser.extractors.stages.hasc import extract_hasc_tables

FIXTURES = Path(__file__).parent / 'fixtures' / 'stages' / 'hasc'
SHA = 'a' * 64
PROFILE = 'fy2027-hasc-authorization-report'
SOURCE_DOCUMENT = 'source-hasc-fy2027'


def load_pages(name: str) -> list[ParserPageResultV1]:
    values = json.loads((FIXTURES / name).read_text())
    return [ParserPageResultV1.model_validate(value) for value in values]


def extract(name: str):
    return extract_hasc_tables(
        pages=load_pages(name),
        profile_id=PROFILE,
        source_document_id=SOURCE_DOCUMENT,
        source_sha256=SHA,
    )


def test_rdte_fixture_preserves_position_and_adjustment_rows() -> None:
    result = extract('rdte.json')
    assert len(result.tables) == 2
    first = result.tables[0]
    assert first.rows[0].reference.referenceKind == 'pe_code'
    assert first.rows[0].reference.peCode == '0605053A'
    assert first.rows[0].semanticKind == 'absolute_position'
    assert first.rows[1].semanticKind == 'adjustment'
    assert first.rows[1].cells[2].value == '15000'


def test_repeated_header_across_pages_is_not_emitted_as_data() -> None:
    result = extract('rdte.json')
    second = result.tables[1]
    assert len(second.rows) == 1
    assert second.rows[0].reference.referenceKind == 'pe_code'
    assert second.rows[0].reference.peCode == '0603270A'


def test_procurement_fixture_keeps_account_namespace_and_quantity_separate() -> None:
    table = extract('procurement.json').tables[0]
    reference = table.rows[0].reference
    assert reference.referenceKind == 'procurement_line'
    assert reference.lineCode == 'W12002'
    assert reference.account == '2035A'
    assert reference.component == 'ARMY'
    quantity_column = next(column for column in table.columns if column.isQuantity)
    assert quantity_column.moneySemantic is None
    assert table.rows[0].cells[quantity_column.columnIndex].value == '12'


def test_om_fixture_emits_native_sag_and_package_undistributed_row() -> None:
    table = extract('om.json').tables[0]
    sag = table.rows[0].reference
    assert sag.referenceKind == 'om_sag'
    assert sag.sagCode == '121'
    assert sag.account == '2020A'
    assert table.rows[1].semanticKind == 'undistributed'
    assert table.rows[1].reference.referenceKind == 'package_scope'
    assert table.rows[1].cells[2].value == '-1000'


def test_milcon_fixture_emits_project_identity_and_general_provision() -> None:
    table = extract('milcon.json').tables[0]
    project = table.rows[0].reference
    assert project.referenceKind == 'milcon_project'
    assert project.projectCode == 'PN12345'
    assert project.component == 'AF'
    assert project.location == 'Eglin AFB'
    assert table.rows[1].semanticKind == 'general_provision'
    assert table.rows[1].reference.referenceKind == 'package_scope'


def test_missing_procurement_account_remains_explicitly_unresolved_for_ts_binding() -> None:
    table = extract('edge-cases.json').tables[0]
    reference = table.rows[0].reference
    assert reference.referenceKind == 'procurement_line'
    assert reference.lineCode == 'W12002'
    assert reference.account is None


def test_unsupported_printed_unit_is_not_inferred_from_magnitude() -> None:
    result = extract('edge-cases.json')
    assert result.tables[0].declaredUnit is None
    assert any('unsupported printed unit billions' in warning for warning in result.warnings)


def test_missing_page_fails_the_parser_runtime_contract() -> None:
    value = json.loads((FIXTURES / 'rdte.json').read_text())[0]
    value.pop('page')
    with pytest.raises(ValidationError):
        ParserPageResultV1.model_validate(value)


def test_json_output_uses_typescript_camel_case_contract() -> None:
    payload = extract('procurement.json').model_dump(mode='json')
    table = payload['tables'][0]
    assert table['schemaVersion'] == 'congressional_table_v1'
    assert table['sourceDocumentId'] == SOURCE_DOCUMENT
    assert table['columns'][1]['moneySemantic'] == 'request_baseline'
    assert table['rows'][0]['reference']['referenceKind'] == 'procurement_line'
    assert 'source_document_id' not in table


def test_replay_is_deterministic() -> None:
    first = extract('rdte.json').model_dump_json()
    second = extract('rdte.json').model_dump_json()
    assert first == second


def test_extractor_has_no_paid_or_external_runtime_imports() -> None:
    source = (
        Path(__file__).parents[1]
        / 'src'
        / 'capiro_defense_budget_parser'
        / 'extractors'
        / 'stages'
        / 'hasc'
        / 'extractor.py'
    ).read_text()
    assert 'llamaparse' not in source.lower()
    assert 'boto3' not in source
    assert 'requests' not in source
    assert 'prisma' not in source.lower()
