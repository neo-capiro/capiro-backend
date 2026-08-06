from __future__ import annotations

import json
from pathlib import Path

from capiro_defense_budget_parser.contracts import ParserPageResultV1
from capiro_defense_budget_parser.extractors.stages.hacd import extract_hacd_tables

FIXTURES = Path(__file__).parent / 'fixtures' / 'stages' / 'hacd'
SHA = 'a' * 64
PROFILE = 'fy2027-hacd-appropriations-report'
SOURCE_DOCUMENT = 'source-hacd-fy2027'


def load_pages(name: str) -> list[ParserPageResultV1]:
    values = json.loads((FIXTURES / name).read_text())
    return [ParserPageResultV1.model_validate(value) for value in values]


def extract(name: str):
    return extract_hacd_tables(
        pages=load_pages(name),
        profile_id=PROFILE,
        source_document_id=SOURCE_DOCUMENT,
        source_sha256=SHA,
    )


def test_rdte_fixture_preserves_absolute_position_and_adjustment() -> None:
    table = extract('rdte.json').tables[0]
    assert table.declaredUnit == 'thousands'
    assert table.rows[0].reference.referenceKind == 'pe_code'
    assert table.rows[0].reference.peCode == '0605053A'
    assert table.rows[0].semanticKind == 'absolute_position'
    assert table.rows[1].semanticKind == 'adjustment'
    assert table.rows[1].cells[2].value == '15000'


def test_procurement_fixture_preserves_account_component_quantity_and_millions() -> None:
    table = extract('procurement.json').tables[0]
    reference = table.rows[0].reference
    assert table.declaredUnit == 'millions'
    assert reference.referenceKind == 'procurement_line'
    assert reference.lineCode == 'W12002'
    assert reference.account == '2035A'
    assert reference.component == 'ARMY'
    quantity = next(column for column in table.columns if column.isQuantity)
    assert quantity.moneySemantic is None
    assert table.rows[0].cells[quantity.columnIndex].value == '12'


def test_om_fixture_strips_footnotes_without_changing_value() -> None:
    table = extract('om.json').tables[0]
    reference = table.rows[0].reference
    assert reference.referenceKind == 'om_sag'
    assert reference.sagCode == '121'
    assert reference.account == '2020A'
    assert table.rows[0].cells[2].value == '2000'
    assert table.rows[0].cells[3].value == '42000'


def test_milcon_fixture_preserves_native_project_context() -> None:
    table = extract('milcon.json').tables[0]
    reference = table.rows[0].reference
    assert reference.referenceKind == 'milcon_project'
    assert reference.projectCode == 'PN12345'
    assert reference.component == 'AF'
    assert reference.location == 'Eglin AFB'


def test_classified_undistributed_row_is_package_scope_action() -> None:
    table = extract('classified.json').tables[0]
    row = table.rows[0]
    assert row.semanticKind == 'undistributed'
    assert row.reference.referenceKind == 'package_scope'
    assert 'classified' in row.reference.scope.lower()
    assert row.cells[2].value == '-10000'


def test_general_transfer_table_keeps_transfer_and_general_provision_as_package_actions() -> None:
    table = extract('general-transfer.json').tables[0]
    assert table.rows[0].semanticKind == 'transfer_out'
    assert table.rows[0].reference.referenceKind == 'package_scope'
    assert table.rows[1].semanticKind == 'general_provision'
    assert table.rows[1].reference.referenceKind == 'package_scope'


def test_repeated_headers_and_house_footnotes_are_not_data() -> None:
    result = extract('edge-cases.json')
    first = result.tables[0]
    assert len(first.rows) == 1
    assert first.rows[0].reference.referenceKind == 'pe_code'
    assert first.rows[0].cells[2].value == '-5000'
    assert first.rows[0].cells[3].value == '85000'


def test_missing_physical_page_is_explicitly_omitted() -> None:
    result = extract('edge-cases.json')
    assert 131 in result.omittedPages
    assert any('physical pages 131-131' in warning for warning in result.warnings)


def test_unsupported_billion_unit_is_never_inferred_from_magnitude() -> None:
    result = extract('edge-cases.json')
    second = result.tables[1]
    assert second.declaredUnit is None
    assert any('unsupported printed unit billions' in warning for warning in result.warnings)


def test_output_uses_cross_language_camel_case_contract_and_replays_deterministically() -> None:
    first = extract('procurement.json')
    payload = first.model_dump(mode='json')
    assert payload['stage'] == 'hac_d'
    assert payload['tables'][0]['sourceDocumentId'] == SOURCE_DOCUMENT
    assert payload['tables'][0]['columns'][1]['moneySemantic'] == 'request_baseline'
    assert 'source_document_id' not in payload['tables'][0]
    assert first.model_dump_json() == extract('procurement.json').model_dump_json()


def test_extractor_contains_no_paid_network_database_or_cloud_runtime_dependency() -> None:
    root = Path(__file__).parents[1] / 'capiro_defense_budget_parser' / 'extractors' / 'stages' / 'hacd'
    source = '\n'.join(path.read_text() for path in root.glob('*.py'))
    for token in ('llamaparse', 'boto3', 'requests', 'httpx', 'prisma', 'sqlalchemy'):
        assert token not in source.lower()
