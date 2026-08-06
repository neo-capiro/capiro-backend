from __future__ import annotations

import json
from pathlib import Path

from capiro_defense_budget_parser.contracts import ParserPageResultV1
from capiro_defense_budget_parser.extractors.stages.sacd import extract_sacd_tables

FIXTURES = Path(__file__).parent / 'fixtures' / 'stages' / 'sacd'
SHA = 'a' * 64
PROFILE = 'fy2027-sacd-defense-appropriations-report'
SOURCE_DOCUMENT = 'source-sacd-fy2027'


def load_pages(name: str) -> list[ParserPageResultV1]:
    values = json.loads((FIXTURES / name).read_text())
    return [ParserPageResultV1.model_validate(value) for value in values]


def extract(name: str):
    return extract_sacd_tables(
        pages=load_pages(name),
        profile_id=PROFILE,
        source_document_id=SOURCE_DOCUMENT,
        source_sha256=SHA,
    )


def test_rdte_uses_senate_appropriations_headers_and_actions() -> None:
    table = extract('rdte.json').tables[0]
    assert table.declaredUnit == 'thousands'
    assert table.columns[3].moneySemantic == 'appropriated_total'
    assert table.rows[0].reference.referenceKind == 'pe_code'
    assert table.rows[0].reference.peCode == '0605053A'
    assert table.rows[1].semanticKind == 'adjustment'
    assert table.rows[1].cells[2].value == '15000'


def test_procurement_split_account_and_component_headings_bind_native_context() -> None:
    table = extract('procurement.json').tables[0]
    reference = table.rows[0].reference
    assert reference.referenceKind == 'procurement_line'
    assert reference.lineCode == 'W12002'
    assert reference.account == '2035A'
    assert reference.component == 'ARMY'
    quantity = next(column for column in table.columns if column.isQuantity)
    assert quantity.moneySemantic is None
    assert table.rows[0].cells[quantity.columnIndex].value == '12'
    assert any(
        'split heading context' in warning for warning in extract('procurement.json').warnings
    )


def test_split_account_context_persists_across_pages() -> None:
    result = extract('om.json')
    table = result.tables[0]
    reference = table.rows[0].reference
    assert reference.referenceKind == 'om_sag'
    assert reference.sagCode == '121'
    assert reference.account == '2020A'
    assert reference.component == 'ARMY'


def test_senate_footnote_markers_do_not_change_money() -> None:
    table = extract('om.json').tables[0]
    assert table.rows[0].cells[2].value == '2000'
    assert table.rows[0].cells[3].value == '42000'


def test_cross_page_footnote_continuation_preserves_original_identity() -> None:
    result = extract('continuation.json')
    table = result.tables[0]
    row = table.rows[0]
    assert table.page == 191
    assert row.reference.referenceKind == 'pe_code'
    assert row.reference.peCode == '0603270A'
    assert row.cells[2].value == '-5000'
    assert row.cells[3].value == '85000'
    assert row.finding == 'continued from physical page 190'


def test_milcon_preserves_project_component_and_location() -> None:
    table = extract('milcon.json').tables[0]
    reference = table.rows[0].reference
    assert reference.referenceKind == 'milcon_project'
    assert reference.projectCode == 'PN12345'
    assert reference.component == 'AF'
    assert reference.location == 'Eglin AFB'


def test_classified_and_transfer_rows_remain_package_scope_actions() -> None:
    table = extract('package-actions.json').tables[0]
    assert [row.semanticKind for row in table.rows] == [
        'undistributed',
        'transfer_out',
        'general_provision',
    ]
    assert all(row.reference.referenceKind == 'package_scope' for row in table.rows)


def test_repeated_headers_are_not_data_and_footnotes_are_normalized() -> None:
    table = extract('edge-cases.json').tables[0]
    assert len(table.rows) == 1
    assert table.rows[0].cells[2].value == '25000'
    assert table.rows[0].cells[3].value == '125000'


def test_missing_physical_page_is_explicitly_omitted() -> None:
    result = extract('edge-cases.json')
    assert 201 in result.omittedPages
    assert any('physical pages 201-201' in warning for warning in result.warnings)


def test_unsupported_billion_unit_is_never_inferred() -> None:
    result = extract('edge-cases.json')
    second = result.tables[1]
    assert second.declaredUnit is None
    assert any('unsupported printed unit billions' in warning for warning in result.warnings)


def test_contract_is_camel_case_and_replays_deterministically() -> None:
    first = extract('procurement.json')
    payload = first.model_dump(mode='json')
    assert payload['stage'] == 'sac_d'
    assert payload['tables'][0]['sourceDocumentId'] == SOURCE_DOCUMENT
    assert payload['tables'][0]['columns'][1]['moneySemantic'] == 'request_baseline'
    assert 'source_document_id' not in payload['tables'][0]
    assert first.model_dump_json() == extract('procurement.json').model_dump_json()


def test_extractor_has_no_paid_network_database_or_cloud_dependency() -> None:
    root = (
        Path(__file__).parents[1]
        / 'capiro_defense_budget_parser'
        / 'extractors'
        / 'stages'
        / 'sacd'
    )
    source = '\n'.join(path.read_text() for path in root.glob('*.py'))
    for token in ('llamaparse', 'boto3', 'requests', 'httpx', 'prisma', 'sqlalchemy'):
        assert token not in source.lower()
