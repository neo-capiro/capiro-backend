"""Phase 6 Workstream G deterministic NDAA conference extraction tests."""

from __future__ import annotations

from pathlib import Path

from capiro_defense_budget_parser.contracts import ParserPageResultV1
from capiro_defense_budget_parser.extractors.stages.ndaa_conference import (
    extract_ndaa_conference_language,
    extract_ndaa_conference_tables,
)

SHA = 'b' * 64
PROFILE = 'fy2027-ndaa-conference'
SOURCE = 'source-ndaa-conf-fy2027'


def page_with_table(
    number: int,
    matrix: list[list[str]],
    *,
    text: str = 'TITLE II — RESEARCH DEVELOPMENT TEST AND EVALUATION',
    printed: str | None = None,
) -> ParserPageResultV1:
    cells = [
        {'rowIndex': row, 'columnIndex': col, 'text': value}
        for row, values in enumerate(matrix)
        for col, value in enumerate(values)
    ]
    return ParserPageResultV1.model_validate(
        {
            'page': number,
            'printedPage': printed,
            'text': text,
            'blocks': [
                {
                    'blockIndex': 0,
                    'blockType': 'heading',
                    'text': text,
                    'readingOrder': 0,
                }
            ],
            'tables': [
                {
                    'tableIndex': 0,
                    'label': text,
                    'rowCount': len(matrix),
                    'columnCount': max(len(row) for row in matrix),
                    'cells': cells,
                    'warnings': [],
                }
            ],
            'images': [],
            'evidencePrecision': 'cell_bbox',
            'warnings': [],
        }
    )


def extract(pages: list[ParserPageResultV1]):
    return extract_ndaa_conference_tables(
        pages=pages,
        profile_id=PROFILE,
        source_document_id=SOURCE,
        source_sha256=SHA,
    )


def test_preserves_house_senate_and_conference_columns() -> None:
    result = extract(
        [
            page_with_table(
                200,
                [
                    [
                        'Program Element',
                        'House Position FY 2027 ($ thousands)',
                        'Senate Position FY 2027',
                        'Conference Agreement FY 2027',
                    ],
                    ['PE 0605053A Ground Robotics', '100000', '120000', '110000'],
                ],
                printed='Joint Explanatory Statement p. 200',
            )
        ]
    )
    bundle = result.tables[0]
    assert [item.role for item in bundle.columnRoles] == [
        'label',
        'hasc',
        'sasc',
        'ndaa_conference',
    ]
    assert bundle.table.rows[0].reference.referenceKind == 'pe_code'
    assert bundle.table.rows[0].reference.peCode == '0605053A'
    assert bundle.table.rows[0].cells[3].value == '110000'
    assert bundle.table.printedPage == 'Joint Explanatory Statement p. 200'


def test_conference_only_total_is_valid_and_chambers_are_not_invented() -> None:
    bundle = extract(
        [
            page_with_table(
                201,
                [
                    ['Program Element', 'Conference Position FY 2027 ($ thousands)'],
                    ['0605053A Ground Robotics', '125000'],
                ],
            )
        ]
    ).tables[0]
    roles = [item.role for item in bundle.columnRoles]
    assert roles == ['label', 'ndaa_conference']
    assert 'hasc' not in roles
    assert 'sasc' not in roles


def test_repeated_header_is_not_emitted_as_data() -> None:
    bundle = extract(
        [
            page_with_table(
                202,
                [
                    ['Program Element', 'Conference Agreement FY 2027 ($ thousands)'],
                    ['Program Element', 'Conference Agreement FY 2027 ($ thousands)'],
                    ['0603270A Electronic Warfare', '72000'],
                ],
            )
        ]
    ).tables[0]
    assert len(bundle.table.rows) == 1
    assert bundle.table.rows[0].reference.peCode == '0603270A'


def test_procurement_identity_preserves_account_and_component() -> None:
    bundle = extract(
        [
            page_with_table(
                203,
                [
                    ['Line Item', 'Conference Agreement FY 2027 ($ thousands)'],
                    ['BLIN W12002 Robotics', '64000'],
                ],
                text='ARMY PROCUREMENT ACCOUNT: 2035A',
            )
        ]
    ).tables[0]
    reference = bundle.table.rows[0].reference
    assert reference.referenceKind == 'procurement_line'
    assert reference.lineCode == 'W12002'
    assert reference.account == '2035A'
    assert reference.component == 'ARMY'


def test_footnoted_conference_amount_is_canonicalized() -> None:
    bundle = extract(
        [
            page_with_table(
                204,
                [
                    ['Program Element', 'Conference Agreement FY 2027 ($ thousands)'],
                    ['0605053A Ground Robotics', '110,000†'],
                ],
            )
        ]
    ).tables[0]
    assert bundle.table.rows[0].cells[1].value == '110000'


def test_missing_physical_page_is_explicitly_omitted() -> None:
    result = extract(
        [
            page_with_table(
                205,
                [['Program Element', 'Conference Position FY 2027 ($ thousands)'], ['0605053A', '1']],
            ),
            page_with_table(
                207,
                [['Program Element', 'Conference Position FY 2027 ($ thousands)'], ['0603270A', '2']],
            ),
        ]
    )
    assert result.omittedPages == [206]


def test_language_extracts_explicit_chamber_disposition_and_deadline() -> None:
    page = ParserPageResultV1.model_validate(
        {
            'page': 300,
            'printedPage': 'JES p. 300',
            'blocks': [
                {'blockIndex': 0, 'blockType': 'heading', 'text': 'Ground Robotics'},
                {
                    'blockIndex': 1,
                    'blockType': 'paragraph',
                    'text': (
                        'For PE 0605053A, the conference agreement adopts the House provision. '
                        'The Senate recedes. The conferees direct the Secretary to submit a report '
                        'to the congressional defense committees within 90 days.'
                    ),
                },
            ],
            'tables': [],
            'images': [],
            'evidencePrecision': 'text_span',
            'warnings': [],
        }
    )
    result = extract_ndaa_conference_language(
        pages=[page],
        fiscal_year=2027,
        profile_id=PROFILE,
        source_document_id=SOURCE,
        source_sha256=SHA,
    )
    provision = result.provisions[0]
    assert provision.references[0].referenceKind == 'pe_code'
    assert provision.deadline is not None and provision.deadline.days == 90
    assert {(item.chamber, item.disposition) for item in provision.chamberDispositions} >= {
        ('house', 'adopted'),
        ('senate', 'receded'),
    }


def test_replay_is_deterministic() -> None:
    pages = [
        page_with_table(
            208,
            [['Program Element', 'Conference Position FY 2027 ($ thousands)'], ['0605053A', '125000']],
        )
    ]
    assert extract(pages).model_dump_json() == extract(pages).model_dump_json()


def test_extractors_have_no_external_or_persistence_dependencies() -> None:
    root = (
        Path(__file__).parents[1]
        / 'src'
        / 'capiro_defense_budget_parser'
        / 'extractors'
        / 'stages'
        / 'ndaa_conference'
    )
    source = '\n'.join(path.read_text() for path in root.glob('*.py')).lower()
    for prohibited in ('llamaparse', 'boto3', 'requests', 'httpx', 'prisma', 'sqlalchemy'):
        assert prohibited not in source
