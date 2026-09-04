"""Tests for the plain PaddleOCR (detection + recognition) targeted OCR
engine with deterministic geometric row/column reconstruction.

These tests validate:
- Default config never enables MKLDNN (Phase 10B-23A/B: broken on the
  tested ARM64 build) and carries sane row/column clustering defaults
- Config SHA is deterministic
- Resource guardrails enforce page limits
- Raw `PaddleOCR.ocr()` output (in either observed return shape) normalizes
  to a flat token list
- Row clustering separates prose (title/header/footnote) from table rows
  by vertical gap, tolerant of the exact fixture used
- Column clustering keeps column identity stable across rows that omit a
  cell, using only tabular (2+ token) rows to build column geometry
- Reconstruction against four REAL captured OCR token sets (Army FY2024
  R-1, pages 11/15/20/37 -- a sparse 2-row summary, a dense PE list with
  known ground-truth dollar values, a 20-line table with missing/merged
  cells, and a single-column boundary page with a cross-page total) never
  attaches a correct number to the wrong Program Element -- the Phase
  10B-23B correctness bar
- Output mapping produces valid ParserPageResultV1
- Confidence is preserved as a string
- Result passes schema and replay checks

PaddleOCR itself is not installed in the test environment — tests that
require the actual PaddleOCR engine use mock objects.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from capiro_defense_budget_parser.contracts import (
    ParserRuntimeResultV1,
    compute_result_content_sha256,
)
from capiro_defense_budget_parser.paddleocr_engine import (
    DEFAULT_PADDLEOCR_CONFIG,
    ENGINE_NAME,
    ENGINE_VERSION,
    ResourceGuardrails,
    _cluster_columns,
    _cluster_rows,
    _extract_tokens,
    _nearest_column_index,
    compute_config_sha256,
    get_default_config,
    process_page_with_paddleocr,
    reconstruct_page_structure,
    run_paddleocr_engine,
    validate_config,
)

FIXTURES_DIR = Path(__file__).parent / 'fixtures'

# ------------------------------------------------------------------ #
# Config tests
# ------------------------------------------------------------------ #


class TestPaddleOCRConfig:
    def test_default_dpi_is_200(self):
        assert DEFAULT_PADDLEOCR_CONFIG['dpi'] == 200

    def test_default_cpu_mode(self):
        assert DEFAULT_PADDLEOCR_CONFIG['cpuMode'] is True
        assert DEFAULT_PADDLEOCR_CONFIG['use_gpu'] is False

    def test_default_mkldnn_disabled(self):
        """Phase 10B-23A/B: MKLDNN is broken on the tested ARM64 paddlepaddle
        build (AnalysisConfig.set_mkldnn_cache_capacity does not exist there),
        confirmed empirically, not architecture-neutral theorizing. There is
        no ARM64 upside to MKLDNN even where present, so it stays off
        everywhere rather than branching by architecture."""
        assert DEFAULT_PADDLEOCR_CONFIG['enable_mkldnn'] is False

    def test_default_no_parallel_processing(self):
        assert DEFAULT_PADDLEOCR_CONFIG['parallelProcessing'] is False

    def test_default_max_pages(self):
        assert DEFAULT_PADDLEOCR_CONFIG['maxPagesPerJob'] == 50

    def test_default_per_page_timeout(self):
        assert DEFAULT_PADDLEOCR_CONFIG['perPageTimeoutSeconds'] == 120

    def test_default_row_gap_ratio(self):
        assert DEFAULT_PADDLEOCR_CONFIG['rowGapRatio'] == 0.6

    def test_default_column_gap_ratio(self):
        assert DEFAULT_PADDLEOCR_CONFIG['columnGapRatio'] == 1.5

    def test_get_default_config_returns_copy(self):
        cfg = get_default_config()
        cfg['dpi'] = 300
        assert DEFAULT_PADDLEOCR_CONFIG['dpi'] == 200  # original unchanged

    def test_config_sha_deterministic(self):
        cfg1 = get_default_config()
        cfg2 = get_default_config()
        assert compute_config_sha256(cfg1) == compute_config_sha256(cfg2)
        assert len(compute_config_sha256(cfg1)) == 64

    def test_config_sha_changes_with_config(self):
        cfg1 = get_default_config()
        cfg2 = get_default_config()
        cfg2['dpi'] = 300
        assert compute_config_sha256(cfg1) != compute_config_sha256(cfg2)


class TestConfigValidation:
    def test_valid_default_config_no_warnings(self):
        warnings = validate_config(get_default_config())
        assert warnings == []

    def test_low_dpi_warning(self):
        cfg = get_default_config()
        cfg['dpi'] = 50
        warnings = validate_config(cfg)
        assert any('dpi below 72' in w for w in warnings)

    def test_high_dpi_warning(self):
        cfg = get_default_config()
        cfg['dpi'] = 800
        warnings = validate_config(cfg)
        assert any('dpi above 600' in w for w in warnings)

    def test_gpu_warning(self):
        cfg = get_default_config()
        cfg['use_gpu'] = True
        warnings = validate_config(cfg)
        assert any('GPU mode' in w for w in warnings)

    def test_invalid_max_pages_warning(self):
        cfg = get_default_config()
        cfg['maxPagesPerJob'] = 0
        warnings = validate_config(cfg)
        assert any('maxPagesPerJob' in w for w in warnings)

    def test_invalid_timeout_warning(self):
        cfg = get_default_config()
        cfg['perPageTimeoutSeconds'] = 0
        warnings = validate_config(cfg)
        assert any('perPageTimeoutSeconds' in w for w in warnings)

    def test_invalid_row_gap_ratio_warning(self):
        cfg = get_default_config()
        cfg['rowGapRatio'] = -1
        warnings = validate_config(cfg)
        assert any('rowGapRatio' in w for w in warnings)

    def test_invalid_column_gap_ratio_warning(self):
        cfg = get_default_config()
        cfg['columnGapRatio'] = 0
        warnings = validate_config(cfg)
        assert any('columnGapRatio' in w for w in warnings)


class TestResourceGuardrails:
    def test_check_page_count_under_limit(self):
        g = ResourceGuardrails(get_default_config())
        g.check_page_count([1, 2, 3])  # should not raise

    def test_check_page_count_at_limit(self):
        cfg = get_default_config()
        cfg['maxPagesPerJob'] = 3
        g = ResourceGuardrails(cfg)
        g.check_page_count([1, 2, 3])  # should not raise

    def test_check_page_count_over_limit_raises(self):
        cfg = get_default_config()
        cfg['maxPagesPerJob'] = 2
        g = ResourceGuardrails(cfg)
        with pytest.raises(ValueError, match='exceeds'):
            g.check_page_count([1, 2, 3])

    def test_get_timeout(self):
        cfg = get_default_config()
        cfg['perPageTimeoutSeconds'] = 60
        g = ResourceGuardrails(cfg)
        assert g.get_timeout() == 60.0

    def test_parallel_disabled_by_default(self):
        g = ResourceGuardrails(get_default_config())
        assert g.parallel is False


# ------------------------------------------------------------------ #
# Token extraction: normalize raw PaddleOCR.ocr() output
# ------------------------------------------------------------------ #


def _line(text: str, x0: float, y0: float, x1: float, y1: float, confidence: float = 0.99):
    return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]], (text, confidence)]


class TestExtractTokens:
    def test_empty_result(self):
        assert _extract_tokens(None) == []
        assert _extract_tokens([]) == []

    def test_bare_list_of_lines_shape(self):
        raw = [_line('Hello', 0, 0, 50, 20)]
        tokens = _extract_tokens(raw)
        assert len(tokens) == 1
        assert tokens[0]['text'] == 'Hello'
        assert tokens[0]['confidence'] == pytest.approx(0.99)
        assert tokens[0]['center_x'] == 25
        assert tokens[0]['center_y'] == 10
        assert tokens[0]['height'] == 20

    def test_nested_per_image_shape(self):
        raw = [[_line('Hello', 0, 0, 50, 20), _line('World', 0, 30, 50, 50)]]
        tokens = _extract_tokens(raw)
        assert len(tokens) == 2
        assert [t['text'] for t in tokens] == ['Hello', 'World']

    def test_nested_shape_with_none_page(self):
        raw = [None]
        assert _extract_tokens(raw) == []


# ------------------------------------------------------------------ #
# Row clustering
# ------------------------------------------------------------------ #


class TestClusterRows:
    def test_empty_tokens(self):
        assert _cluster_rows([], row_gap_ratio=0.6) == []

    def test_single_row_single_token(self):
        tokens = _extract_tokens([_line('Title', 0, 0, 100, 20)])
        rows = _cluster_rows(tokens, row_gap_ratio=0.6)
        assert len(rows) == 1
        assert len(rows[0]) == 1

    def test_two_far_apart_lines_are_separate_rows(self):
        tokens = _extract_tokens(
            [_line('Row one', 0, 0, 100, 20), _line('Row two', 0, 200, 100, 220)]
        )
        rows = _cluster_rows(tokens, row_gap_ratio=0.6)
        assert len(rows) == 2

    def test_same_row_tokens_ordered_left_to_right(self):
        tokens = _extract_tokens(
            [_line('Second', 60, 0, 100, 20), _line('First', 0, 0, 50, 20)]
        )
        rows = _cluster_rows(tokens, row_gap_ratio=0.6)
        assert len(rows) == 1
        assert [t['text'] for t in rows[0]] == ['First', 'Second']

    def test_missing_cell_does_not_create_extra_row(self):
        """A row that skips a column must still be ONE row, not split."""
        tokens = _extract_tokens(
            [
                _line('PE0601121A', 0, 500, 100, 520),
                _line('Title text', 110, 500, 300, 520),
                # no FY2022 cell for this row
                _line('77,000', 400, 500, 460, 520),
            ]
        )
        rows = _cluster_rows(tokens, row_gap_ratio=0.6)
        assert len(rows) == 1
        assert len(rows[0]) == 3


# ------------------------------------------------------------------ #
# Column clustering
# ------------------------------------------------------------------ #


class TestClusterColumns:
    def test_no_tabular_rows_yields_no_columns(self):
        rows = _cluster_rows(_extract_tokens([_line('Solo', 0, 0, 100, 20)]), row_gap_ratio=0.6)
        centers, count = _cluster_columns(rows, column_gap_ratio=1.5)
        assert centers == []
        assert count == 0

    def test_prose_rows_do_not_widen_column_geometry(self):
        tokens = _extract_tokens(
            [
                _line('A very long title line that spans most of the page width', 0, 0, 900, 20),
                _line('PE001', 0, 100, 80, 120),
                _line('12,345', 300, 100, 380, 120),
            ]
        )
        rows = _cluster_rows(tokens, row_gap_ratio=0.6)
        centers, count = _cluster_columns(rows, column_gap_ratio=1.5)
        assert count == 2  # only the tabular row's two cells define columns

    def test_missing_cell_keeps_remaining_values_in_correct_columns(self):
        """Regression for the exact real-world pattern seen on page 20, line
        68 ('Cross Functional Team'): a row missing its FY2022 Actuals cell
        must not shift its FY2023 values into the FY2022 column."""
        tokens = _extract_tokens(
            [
                _line('PE_A', 0, 0, 80, 20),
                _line('10,000', 200, 0, 280, 20),
                _line('20,000', 400, 0, 480, 20),
                _line('30,000', 600, 0, 680, 20),
                # second row omits the middle (FY2022) column entirely
                _line('PE_B', 0, 40, 80, 60),
                _line('77,000', 400, 40, 480, 60),
                _line('77,000', 600, 40, 680, 60),
            ]
        )
        rows = _cluster_rows(tokens, row_gap_ratio=0.6)
        assert len(rows) == 2
        centers, count = _cluster_columns(rows, column_gap_ratio=1.5)
        assert count == 4

        row_b = rows[1]
        row_b_columns = [_nearest_column_index(t['center_x'], centers) for t in row_b]
        # PE_B's two dollar values must land in columns 2 and 3 (matching
        # PE_A's own FY2023-column positions), not 1 and 2.
        assert row_b_columns == [0, 2, 3]


# ------------------------------------------------------------------ #
# Full reconstruction: synthetic + real captured fixtures
# ------------------------------------------------------------------ #


def _load_fixture_tokens(name: str) -> list[dict]:
    with open(FIXTURES_DIR / name, encoding='utf-8') as f:
        data = json.load(f)
    raw = [
        _line(t['text'], t['bbox'][0], t['bbox'][1], t['bbox'][2], t['bbox'][3], t['confidence'])
        for t in data['tokens']
    ]
    return _extract_tokens(raw)


def _table_row_texts(tables) -> list[list[str]]:
    if not tables:
        return []
    table = tables[0]
    by_row: dict[int, list] = {}
    for cell in table.cells:
        by_row.setdefault(cell.rowIndex, []).append(cell)
    rows = []
    for row_index in sorted(by_row):
        cells = sorted(by_row[row_index], key=lambda c: c.columnIndex)
        rows.append([c.text for c in cells])
    return rows


class TestReconstructPageStructure:
    def test_single_cell_rows_become_paragraph_blocks(self):
        tokens = _extract_tokens(
            [_line('UNCLASSIFIED', 0, 0, 100, 20), _line('Page 1', 0, 40, 100, 60)]
        )
        blocks, tables, full_text = reconstruct_page_structure(
            tokens, row_gap_ratio=0.6, column_gap_ratio=1.5
        )
        assert len(blocks) == 2
        assert [b.blockType for b in blocks] == ['paragraph', 'paragraph']
        assert tables == []
        assert full_text == 'UNCLASSIFIED\nPage 1'

    def test_multi_cell_rows_become_one_table(self):
        tokens = _extract_tokens(
            [
                _line('PE001', 0, 0, 80, 20),
                _line('12,345', 200, 0, 280, 20),
                _line('PE002', 0, 40, 80, 60),
                _line('67,890', 200, 40, 280, 60),
            ]
        )
        blocks, tables, _ = reconstruct_page_structure(
            tokens, row_gap_ratio=0.6, column_gap_ratio=1.5
        )
        assert blocks == []
        assert len(tables) == 1
        assert tables[0].rowCount == 2
        assert tables[0].columnCount == 2
        assert _table_row_texts(tables) == [['PE001', '12,345'], ['PE002', '67,890']]

    def test_confidence_preserved_as_string(self):
        tokens = _extract_tokens(
            [_line('A', 0, 0, 40, 20, 0.87), _line('B', 100, 0, 140, 20, 0.92)]
        )
        _, tables, _ = reconstruct_page_structure(tokens, row_gap_ratio=0.6, column_gap_ratio=1.5)
        confidences = {c.text: c.confidence for c in tables[0].cells}
        assert confidences['A'] == str(0.87)
        assert confidences['B'] == str(0.92)

    def test_table_bounding_box_is_populated_not_null(self):
        """Regression: the TS-side Zod contract requires `boundingBox` to be
        either present or omitted, never an explicit `null` (`.optional()`,
        not `.nullish()`) -- a real production failure this exact gap caused
        the first time paddleocr actually reached a real table (Phase
        10B-23B, r2-production-path-no-override.spec.ts)."""
        tokens = _extract_tokens(
            [
                _line('PE001', 0, 100, 80, 120),
                _line('12,345', 300, 100, 380, 120),
                _line('PE002', 0, 140, 80, 160),
                _line('67,890', 300, 140, 380, 160),
            ]
        )
        _, tables, _ = reconstruct_page_structure(tokens, row_gap_ratio=0.6, column_gap_ratio=1.5)
        assert tables[0].boundingBox is not None
        box = tables[0].boundingBox
        assert float(box.x0) == 0
        assert float(box.y0) == 100
        assert float(box.x1) == 380
        assert float(box.y1) == 160

    # -- real captured OCR token sets --------------------------------- #

    def test_page11_sparse_summary_recovers_dropped_dollar_rows(self):
        """This is the exact page PP-Structure's layout model silently
        dropped (zero regions covered the numeric rows at all, Phase
        10B-23A). Plain det+rec must recover both data rows in full."""
        tokens = _load_fixture_tokens('army-fy2024-r1-page11-ocr-tokens.json')
        _, tables, full_text = reconstruct_page_structure(
            tokens, row_gap_ratio=0.6, column_gap_ratio=1.5
        )
        rows = _table_row_texts(tables)
        army_row = next(r for r in rows if 'Research, Development, Test and Evaluation, Army' in r)
        assert army_row == [
            'Research, Development, Test and Evaluation, Army',
            '14,660,654', '17,142,121', '9,100', '17,151,221', '15,775,381',
        ]
        assert 'Volume 1a -vii' in full_text

    def test_page15_matches_known_pe_ground_truth_exactly(self):
        """Five Program Elements with known-correct FY2024 Request dollar
        values (verified against the source document). This is the same
        page PP-Structure's SLANet table model -- even after the paddle
        3.1.x/3.2.x crash fix -- misattributed 0601121A's value to
        0601601A's row (Phase 10B-23B bake-off). Deterministic geometric
        reconstruction over plain det+rec tokens must not repeat that."""
        tokens = _load_fixture_tokens('army-fy2024-r1-page15-ocr-tokens.json')
        _, tables, _ = reconstruct_page_structure(tokens, row_gap_ratio=0.6, column_gap_ratio=1.5)
        rows = _table_row_texts(tables)

        ground_truth = {
            '0601102A': '296,670',
            '0601103A': '75,672',
            '0601104A': '108,946',
            '0601121A': '5,459',
            '0601601A': '10,708',
        }
        for pe_code, expected_value in ground_truth.items():
            row = next((r for r in rows if pe_code in r), None)
            assert row is not None, f'{pe_code} not found in any reconstructed row'
            assert expected_value in row, (
                f'{pe_code} row {row} does not contain its correct value {expected_value} -- '
                'a value attached to the wrong PE is the exact failure this engine exists to avoid'
            )

    def test_page20_dense_table_with_missing_and_merged_cells(self):
        """20 line items including a row with no FY2022 value at all (line
        68) and a row with zero dollar values (line 74, classified/no
        data) -- both must reconstruct without misattributing a
        neighboring row's number."""
        tokens = _load_fixture_tokens('army-fy2024-r1-page20-ocr-tokens.json')
        _, tables, _ = reconstruct_page_structure(tokens, row_gap_ratio=0.6, column_gap_ratio=1.5)
        rows = _table_row_texts(tables)

        line62 = next(r for r in rows if '0603801A' in r)
        assert '1,138,457' in line62
        assert '1,157,472' in line62

        line76 = next(r for r in rows if '0604114A' in r)
        assert '408,766' in line76
        assert '380,147' in line76

    def test_page37_boundary_page_cross_checks_grand_total(self):
        """The Army-wide grand total on the LAST detail page must equal the
        FY2024 Request total shown on the FIRST summary page (page 11) --
        an independent, cross-page correctness check."""
        tokens = _load_fixture_tokens('army-fy2024-r1-page37-ocr-tokens.json')
        _, tables, full_text = reconstruct_page_structure(
            tokens, row_gap_ratio=0.6, column_gap_ratio=1.5
        )
        rows = _table_row_texts(tables)
        total_row = next(
            r for r in rows if 'Total Research, Development, Test and Evaluation, Army' in r
        )
        assert '15,775,381' in total_row


# ------------------------------------------------------------------ #
# process_page_with_paddleocr
# ------------------------------------------------------------------ #


def _fake_page_image():
    """A minimal real (numpy-convertible) stand-in for a rendered PIL page
    image -- a MagicMock fails `np.array(img)` unpredictably rather than
    raising cleanly, which the engine's own error handling would then (with
    some list shapes) mask as a processing error instead of exercising the
    code path a test intends to cover."""
    import numpy as np
    from PIL import Image

    return Image.fromarray(np.zeros((10, 10, 3), dtype=np.uint8), mode='RGB')


class TestProcessPageWithPaddleOCR:
    def test_empty_result_has_page_only_precision(self):
        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(return_value=[])
        result = process_page_with_paddleocr(
            engine=mock_engine,
            img=_fake_page_image(),
            page_number=1,
            config=get_default_config(),
        )
        assert result.evidencePrecision == 'page_only'
        assert result.tables == []

    def test_table_result_has_cell_bbox_precision(self):
        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(
            return_value=[[_line('PE1', 0, 0, 60, 20), _line('123', 200, 0, 260, 20)]]
        )
        result = process_page_with_paddleocr(
            engine=mock_engine,
            img=_fake_page_image(),
            page_number=1,
            config=get_default_config(),
        )
        assert result.evidencePrecision == 'cell_bbox'
        assert len(result.tables) == 1

    def test_processing_error_produces_warning_not_crash(self):
        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(side_effect=RuntimeError('model crashed'))
        result = process_page_with_paddleocr(
            engine=mock_engine,
            img=_fake_page_image(),
            page_number=1,
            config=get_default_config(),
        )
        assert any('PaddleOCR processing error' in w for w in result.warnings)
        assert result.tables == []
        assert result.blocks == []

    def test_page_number_and_dimensions_preserved(self):
        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(return_value=[])
        result = process_page_with_paddleocr(
            engine=mock_engine,
            img=_fake_page_image(),
            page_number=7,
            config=get_default_config(),
            page_width=612.0,
            page_height=792.0,
            rotation=90,
        )
        assert result.page == 7
        assert result.width == '612.0'
        assert result.height == '792.0'
        assert result.rotation == 90


# ------------------------------------------------------------------ #
# run_paddleocr_engine (integration)
# ------------------------------------------------------------------ #


def _make_test_pdf(path: Path, num_pages: int = 2) -> str:
    """Create a minimal, valid, multi-page PDF and return its SHA-256."""
    import hashlib

    objects = []
    kids = ' '.join(f'{3 + i} 0 R' for i in range(num_pages))
    objects.append(b'<</Type/Catalog/Pages 2 0 R>>')
    objects.append(f'<</Type/Pages/Kids[{kids}]/Count {num_pages}>>'.encode())
    for _ in range(num_pages):
        objects.append(b'<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>')

    body = b'%PDF-1.4\n'
    offsets = [0]
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(body))
        body += f'{i} 0 obj'.encode() + obj + b'endobj\n'
    xref_offset = len(body)
    body += f'xref\n0 {len(objects) + 1}\n'.encode()
    body += b'0000000000 65535 f \n'
    for off in offsets[1:]:
        body += f'{off:010d} 00000 n \n'.encode()
    body += f'trailer<</Size {len(objects) + 1}/Root 1 0 R>>\n'.encode()
    body += f'startxref\n{xref_offset}\n%%EOF'.encode()

    path.write_bytes(body)
    return hashlib.sha256(body).hexdigest()


class TestRunPaddleOCREngine:
    def test_source_sha_mismatch_fails(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        _make_test_pdf(pdf_path, num_pages=1)

        wrong_sha = '0' * 64
        with pytest.raises(ValueError, match='source SHA mismatch'):
            run_paddleocr_engine(
                source_path=pdf_path,
                expected_sha256=wrong_sha,
                requested_pages=[1],
            )

    def test_page_count_exceeds_guardrail(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        cfg = get_default_config()
        cfg['maxPagesPerJob'] = 1
        with pytest.raises(ValueError, match='exceeds'):
            run_paddleocr_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1, 2, 3],
                config=cfg,
            )

    def test_paddleocr_not_installed_fails_all_pages(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        with patch(
            'capiro_defense_budget_parser.paddleocr_engine._create_paddle_ocr',
            side_effect=RuntimeError('PaddleOCR is not installed'),
        ):
            result = run_paddleocr_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        assert isinstance(result, ParserRuntimeResultV1)
        assert len(result.failedPages) == 1
        assert result.failedPages[0].code == 'model_unavailable'
        assert result.metrics.pagesSucceeded == 0
        assert result.engine == ENGINE_NAME
        assert result.parserVersion == ENGINE_VERSION

    def test_result_content_sha_is_deterministic(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(return_value=[])

        with (
            patch(
                'capiro_defense_budget_parser.paddleocr_engine._create_paddle_ocr',
                return_value=mock_engine,
            ),
            patch(
                'capiro_defense_budget_parser.paddleocr_engine.render_page_to_image',
                return_value=MagicMock(),
            ),
        ):
            result1 = run_paddleocr_engine(
                source_path=pdf_path, expected_sha256=actual_sha, requested_pages=[1]
            )
            result2 = run_paddleocr_engine(
                source_path=pdf_path, expected_sha256=actual_sha, requested_pages=[1]
            )

        assert result1.contentSha256 == result2.contentSha256
        assert len(result1.contentSha256) == 64

    def test_result_passes_schema_validation(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(return_value=[])

        with (
            patch(
                'capiro_defense_budget_parser.paddleocr_engine._create_paddle_ocr',
                return_value=mock_engine,
            ),
            patch(
                'capiro_defense_budget_parser.paddleocr_engine.render_page_to_image',
                return_value=MagicMock(),
            ),
        ):
            result = run_paddleocr_engine(
                source_path=pdf_path, expected_sha256=actual_sha, requested_pages=[1]
            )

        re_parsed = ParserRuntimeResultV1.model_validate(result.model_dump())
        assert re_parsed.schemaVersion == 'defense_budget_parser_result_v1'
        assert re_parsed.engine == 'paddleocr'

    def test_result_replay_check(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(return_value=[])

        with (
            patch(
                'capiro_defense_budget_parser.paddleocr_engine._create_paddle_ocr',
                return_value=mock_engine,
            ),
            patch(
                'capiro_defense_budget_parser.paddleocr_engine.render_page_to_image',
                return_value=MagicMock(),
            ),
        ):
            result = run_paddleocr_engine(
                source_path=pdf_path, expected_sha256=actual_sha, requested_pages=[1]
            )

        recomputed = compute_result_content_sha256(result.model_dump())
        assert recomputed == result.contentSha256

    def test_config_sha_in_result_matches_config(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)
        cfg = get_default_config()

        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(return_value=[])

        with (
            patch(
                'capiro_defense_budget_parser.paddleocr_engine._create_paddle_ocr',
                return_value=mock_engine,
            ),
            patch(
                'capiro_defense_budget_parser.paddleocr_engine.render_page_to_image',
                return_value=MagicMock(),
            ),
        ):
            result = run_paddleocr_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
                config=cfg,
            )

        assert result.parserConfigSha256 == compute_config_sha256(cfg)

    def test_no_paid_network_parser(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(return_value=[])

        with (
            patch(
                'capiro_defense_budget_parser.paddleocr_engine._create_paddle_ocr',
                return_value=mock_engine,
            ),
            patch(
                'capiro_defense_budget_parser.paddleocr_engine.render_page_to_image',
                return_value=MagicMock(),
            ),
        ):
            result = run_paddleocr_engine(
                source_path=pdf_path, expected_sha256=actual_sha, requested_pages=[1]
            )

        assert result.engine == 'paddleocr'
        assert result.engine != 'llamaparse'

    def test_multiple_pages_processed(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=3)

        mock_engine = MagicMock()
        mock_engine.ocr = MagicMock(return_value=[])

        with (
            patch(
                'capiro_defense_budget_parser.paddleocr_engine._create_paddle_ocr',
                return_value=mock_engine,
            ),
            patch(
                'capiro_defense_budget_parser.paddleocr_engine.render_page_to_image',
                return_value=MagicMock(),
            ),
        ):
            result = run_paddleocr_engine(
                source_path=pdf_path, expected_sha256=actual_sha, requested_pages=[1, 2, 3]
            )

        assert result.metrics.pagesProcessed == 3
        assert len(result.pages) == 3
        assert [p.page for p in result.pages] == [1, 2, 3]


# ------------------------------------------------------------------ #
# Page rendering
# ------------------------------------------------------------------ #


class TestPageRendering:
    def test_render_page_out_of_range_raises(self, tmp_path: Path):
        from capiro_defense_budget_parser.paddleocr_engine import render_page_to_image

        pdf_path = tmp_path / 'test.pdf'
        _make_test_pdf(pdf_path, num_pages=1)

        pytest.importorskip('pypdfium2')

        with pytest.raises(ValueError, match='out of range'):
            render_page_to_image(pdf_path, 99, dpi=200)


# ------------------------------------------------------------------ #
# Engine identity
# ------------------------------------------------------------------ #


class TestEngineIdentity:
    def test_engine_name_is_paddleocr(self):
        assert ENGINE_NAME == 'paddleocr'

    def test_engine_version_does_not_reference_pp_structure(self):
        """Phase 10B-23B: this engine must never construct PP-Structure."""
        assert 'pp-structure' not in ENGINE_VERSION.lower()
        assert 'structure' not in ENGINE_VERSION.lower()

    def test_drain_dockerfile_bakes_every_model_paddleocr_downloads_at_construction(self):
        """Phase 10B-23C offline-runtime regression.

        PaddleOCR 2.x's `PaddleOCR.__init__` calls `maybe_download()` for the
        det, rec AND cls model dirs UNCONDITIONALLY (regardless of
        `use_angle_cls=False`) -- `ppocr/utils/network.py::maybe_download`
        only skips the download when `inference.pdiparams` +
        `inference.pdmodel` already exist at the target path. The
        ingestion-drain image therefore must bake all three model sets, or
        the first real run in a network-isolated task fails
        `model_unavailable` on the unused cls model (reproduced 2026-09-04
        with `docker run --network none`).

        This test pins the CONTRACT (every model URL paddleocr can fetch at
        construction has a matching `bake_model` line with a 64-hex sha256
        for both .pdiparams and .pdmodel); the checksums themselves are
        verified at docker build time by `sha256sum -c` inside the RUN, and
        the full offline proof is the `--network none` container run.
        """
        dockerfile = (
            Path(__file__).resolve().parents[2]
            / 'api'
            / 'Dockerfile.defense-budget-ingestion-drain'
        )
        if not dockerfile.exists():
            pytest.skip('Dockerfile.defense-budget-ingestion-drain not present in this checkout')
        content = dockerfile.read_text(encoding='utf-8')

        # Every paddleocr CDN model URL the image references must be baked
        # (the bake_model helper's URL argument), and each bake must carry
        # two 64-hex checksums (pdiparams + pdmodel).
        bake_urls = re.findall(r'bake_model\s+(\S+\.tar)', content)
        assert bake_urls, 'no bake_model lines found in ingestion-drain Dockerfile'

        expected_urls = {
            # det + rec (used by the engine) and cls (unused but still
            # downloaded by PaddleOCR's constructor unconditionally).
            'https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_det_infer.tar',
            'https://paddleocr.bj.bcebos.com/PP-OCRv4/chinese/ch_PP-OCRv4_rec_infer.tar',
            'https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/ch_ppocr_mobile_v2.0_cls_infer.tar',
        }
        assert expected_urls.issubset(set(bake_urls)), (
            f'missing bakes for: {sorted(expected_urls - set(bake_urls))}'
        )

        # Each bake_model call must be followed by two 64-hex digests (the
        # URL + dest-dir lines can consume ~200 chars before the digests).
        for url in expected_urls:
            idx = content.index(url)
            tail = content[idx : idx + 600]
            digests = re.findall(r'\b[0-9a-f]{64}\b', tail[:400])
            assert len(digests) >= 2, f'bake for {url} lacks pdiparams/pdmodel sha256 pair'
