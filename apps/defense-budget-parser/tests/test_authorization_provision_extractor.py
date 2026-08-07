"""Phase 6 Workstream F authorization-provision extractor tests."""

from __future__ import annotations

from pathlib import Path

from capiro_defense_budget_parser.contracts import ParserPageResultV1
from capiro_defense_budget_parser.extractors.stages.provisions import (
    extract_authorization_provisions,
)

SHA = 'a' * 64


def page(number: int, blocks: list[dict], printed: str | None = None) -> ParserPageResultV1:
    return ParserPageResultV1.model_validate(
        {
            'page': number,
            'printedPage': printed,
            'blocks': blocks,
            'tables': [],
            'images': [],
            'evidencePrecision': 'text_span',
            'warnings': [],
        }
    )


def extract(pages: list[ParserPageResultV1], known_titles: list[str] | None = None):
    return extract_authorization_provisions(
        pages=pages,
        stage='hasc',
        fiscal_year=2027,
        profile_id='fy2027-hasc-authorization-report',
        source_document_id='source-hasc-fy2027',
        source_sha256=SHA,
        known_titles=known_titles,
    )


def test_extracts_full_text_deadline_recipient_and_exact_pe() -> None:
    result = extract(
        [
            page(
                40,
                [
                    {'blockIndex': 0, 'blockType': 'heading', 'text': 'Ground Robotics'},
                    {
                        'blockIndex': 1,
                        'blockType': 'paragraph',
                        'text': (
                            'For Program Element 0605053A, the committee directs the Secretary '
                            'to submit a report to the congressional defense committees not later '
                            'than March 15, 2027.'
                        ),
                    },
                ],
                'H. Rept. 119-000, p. 40',
            )
        ]
    )
    provision = result.provisions[0]
    assert provision.actionType == 'directs_report'
    assert provision.deadline is not None
    assert provision.deadline.kind == 'date'
    assert provision.deadline.isoDate == '2027-03-15'
    assert provision.reportingRecipient is not None
    assert provision.reportingRecipient.normalized == 'congressional defense committees'
    assert provision.references[0].referenceKind == 'pe_code'
    assert provision.references[0].peCode == '0605053A'
    assert provision.pageRange.printedStart == 'H. Rept. 119-000, p. 40'


def test_exact_project_requires_project_code_under_exact_pe() -> None:
    result = extract(
        [
            page(
                41,
                [
                    {'blockIndex': 0, 'blockType': 'heading', 'text': 'Autonomy Project'},
                    {
                        'blockIndex': 1,
                        'blockType': 'paragraph',
                        'text': (
                            'Project TRX-01 under PE 0605053A shall provide a briefing '
                            'within 90 days.'
                        ),
                    },
                ],
            )
        ]
    )
    reference = result.provisions[0].references[0]
    assert reference.referenceKind == 'rdte_project'
    assert reference.peCode == '0605053A'
    assert reference.projectCode == 'TRX-01'
    assert result.provisions[0].deadline.days == 90


def test_procurement_om_and_milcon_exact_namespaces_are_preserved() -> None:
    result = extract(
        [
            page(
                42,
                [
                    {'blockIndex': 0, 'blockType': 'heading', 'text': 'Native lines'},
                    {
                        'blockIndex': 1,
                        'blockType': 'paragraph',
                        'text': (
                            'Army Account: 2035A BLIN W12002 and SAG 121 are addressed. '
                            'Air Force MILCON Project PN12345 Location: Eglin AFB.'
                        ),
                    },
                ],
            )
        ]
    )
    kinds = {reference.referenceKind for reference in result.provisions[0].references}
    assert {'procurement_line', 'om_sag', 'milcon_project'} <= kinds


def test_title_only_match_is_explicit_and_never_an_exact_code() -> None:
    result = extract(
        [
            page(
                43,
                [
                    {'blockIndex': 0, 'blockType': 'heading', 'text': 'Ground Robotics'},
                    {
                        'blockIndex': 1,
                        'blockType': 'paragraph',
                        'text': 'The committee remains concerned about Ground Robotics maturity.',
                    },
                ],
            )
        ],
        known_titles=['Ground Robotics'],
    )
    reference = result.provisions[0].references[0]
    assert reference.referenceKind == 'title_only'
    assert result.provisions[0].actionType == 'expresses_concern'


def test_program_wide_language_has_attribution_caveat() -> None:
    result = extract(
        [
            page(
                44,
                [
                    {'blockIndex': 0, 'blockType': 'heading', 'text': 'Program-wide direction'},
                    {
                        'blockIndex': 1,
                        'blockType': 'paragraph',
                        'text': 'Across the program, the committee encourages improved testing.',
                    },
                ],
            )
        ]
    )
    provision = result.provisions[0]
    assert provision.scope == 'program_wide'
    assert provision.attributionCaveat is not None
    assert 'do not attribute' in provision.attributionCaveat.lower()


def test_cross_page_provision_preserves_page_range_and_evidence() -> None:
    result = extract(
        [
            page(
                45,
                [
                    {'blockIndex': 0, 'blockType': 'heading', 'text': 'Cross-page directive'},
                    {'blockIndex': 1, 'blockType': 'paragraph', 'text': 'The committee directs'},
                ],
            ),
            page(
                46,
                [
                    {
                        'blockIndex': 0,
                        'blockType': 'paragraph',
                        'text': 'the Secretary to provide a briefing within 30 days.',
                    }
                ],
            ),
        ]
    )
    provision = result.provisions[0]
    assert provision.pageRange.startPage == 45
    assert provision.pageRange.endPage == 46
    assert len(provision.evidenceIds) == 3
    assert {item.page for item in result.evidence} == {45, 46}


def test_missing_physical_page_is_explicitly_omitted() -> None:
    result = extract(
        [
            page(
                47,
                [
                    {'blockIndex': 0, 'blockType': 'heading', 'text': 'Before gap'},
                    {'blockIndex': 1, 'blockType': 'paragraph', 'text': 'Narrative text.'},
                ],
            ),
            page(
                49,
                [
                    {'blockIndex': 0, 'blockType': 'heading', 'text': 'After gap'},
                    {'blockIndex': 1, 'blockType': 'paragraph', 'text': 'Narrative text.'},
                ],
            ),
        ]
    )
    assert result.omittedPages == [48]
    assert any('missing from parser result' in warning for warning in result.warnings)


def test_duplicate_input_replays_to_identical_provision_id() -> None:
    pages = [
        page(
            50,
            [
                {'blockIndex': 0, 'blockType': 'heading', 'text': 'Stable directive'},
                {
                    'blockIndex': 1,
                    'blockType': 'paragraph',
                    'text': 'The committee encourages testing.',
                },
            ],
        )
    ]
    first = extract(pages).model_dump_json()
    second = extract(pages).model_dump_json()
    assert first == second


def test_extractor_has_no_external_or_persistence_imports() -> None:
    source = (
        Path(__file__).parents[1]
        / 'src'
        / 'capiro_defense_budget_parser'
        / 'extractors'
        / 'stages'
        / 'provisions'
        / 'extractor.py'
    ).read_text()
    lowered = source.lower()
    for prohibited in ('llamaparse', 'boto3', 'requests', 'httpx', 'prisma', 'sqlalchemy'):
        assert prohibited not in lowered
