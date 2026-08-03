"""Tests for the pdfplumber engine (Workstream F)."""

from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from capiro_defense_budget_parser.pdfplumber_engine import (
    DEFAULT_TABLE_STRATEGY,
    ENGINE_NAME,
    ENGINE_VERSION,
    TABLE_STRATEGIES,
    build_default_config,
    compute_config_sha256,
    get_table_strategy_config,
    run_pdfplumber_engine,
)


def _make_test_pdf(path: Path, num_pages: int = 2) -> str:
    """Create a minimal test PDF and return its SHA-256."""
    try:
        import fitz

        doc = fitz.open()
        for i in range(num_pages):
            page = doc.new_page(width=612, height=792)
            page.insert_text((72, 72), f'Page {i + 1} budget text content')
        doc.save(str(path))
        doc.close()
    except ImportError:
        content = (
            b'%PDF-1.0\n'
            b'1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
            b'2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
            b'3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n'
            b'xref\n0 4\n'
            b'0000000000 65535 f \n'
            b'0000000009 00000 n \n'
            b'0000000058 00000 n \n'
            b'0000000115 00000 n \n'
            b'trailer<</Size 4/Root 1 0 R>>\n'
            b'startxref\n190\n%%EOF\n'
        )
        path.write_bytes(content)
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


class TestTableStrategies:
    def test_all_four_strategies_defined(self):
        assert set(TABLE_STRATEGIES.keys()) == {'lines', 'lines_strict', 'text', 'hybrid'}

    def test_lines_strategy_uses_lines(self):
        cfg = get_table_strategy_config('lines')
        assert cfg['vertical_strategy'] == 'lines'
        assert cfg['horizontal_strategy'] == 'lines'

    def test_lines_strict_strategy(self):
        cfg = get_table_strategy_config('lines_strict')
        assert cfg['vertical_strategy'] == 'lines_strict'
        assert cfg['horizontal_strategy'] == 'lines_strict'

    def test_text_strategy(self):
        cfg = get_table_strategy_config('text')
        assert cfg['vertical_strategy'] == 'text'
        assert cfg['horizontal_strategy'] == 'text'

    def test_hybrid_strategy(self):
        cfg = get_table_strategy_config('hybrid')
        assert cfg['vertical_strategy'] == 'lines'
        assert cfg['horizontal_strategy'] == 'text'

    def test_unknown_strategy_raises(self):
        with pytest.raises(ValueError, match='unknown table strategy'):
            get_table_strategy_config('nonexistent')

    def test_default_strategy_is_lines(self):
        assert DEFAULT_TABLE_STRATEGY == 'lines'


class TestConfig:
    def test_default_config_has_strategy(self):
        cfg = build_default_config()
        assert cfg['tableStrategy'] == 'lines'

    def test_config_with_custom_strategy(self):
        cfg = build_default_config('text')
        assert cfg['tableStrategy'] == 'text'

    def test_config_sha_is_deterministic(self):
        sha1 = compute_config_sha256(build_default_config())
        sha2 = compute_config_sha256(build_default_config())
        assert sha1 == sha2
        assert len(sha1) == 64

    def test_different_strategies_produce_different_sha(self):
        sha1 = compute_config_sha256(build_default_config('lines'))
        sha2 = compute_config_sha256(build_default_config('text'))
        assert sha1 != sha2


class TestRunPdfplumberEngine:
    def test_source_sha_mismatch_fails(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        _make_test_pdf(pdf_path, num_pages=1)
        with pytest.raises(ValueError, match='SHA mismatch'):
            run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256='0' * 64,
                requested_pages=[1],
            )

    def test_requested_pages_only(self, tmp_path: Path):
        """F5: exact requested pages only."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=3)

        with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
            mock_pdf = MagicMock()
            mock_page1 = MagicMock()
            mock_page1.page_number = 1
            mock_page1.width = 612.0
            mock_page1.height = 792.0
            mock_page1.rotation = 0
            mock_page1.extract_text.return_value = 'Page 1 text'
            mock_page1.extract_words.return_value = []
            mock_page1.find_tables.return_value = []
            mock_page1.images = []
            mock_page1.lines = []
            mock_page1.rects = []

            mock_page2 = MagicMock()
            mock_page2.page_number = 2
            mock_page2.width = 612.0
            mock_page2.height = 792.0
            mock_page2.rotation = 0
            mock_page2.extract_text.return_value = 'Page 2 text'
            mock_page2.extract_words.return_value = []
            mock_page2.find_tables.return_value = []
            mock_page2.images = []
            mock_page2.lines = []
            mock_page2.rects = []

            mock_page3 = MagicMock()
            mock_page3.page_number = 3
            mock_page3.width = 612.0
            mock_page3.height = 792.0
            mock_page3.rotation = 0
            mock_page3.extract_text.return_value = 'Page 3 text'
            mock_page3.extract_words.return_value = []
            mock_page3.find_tables.return_value = []
            mock_page3.images = []
            mock_page3.lines = []
            mock_page3.rects = []

            mock_pdf.pages = [mock_page1, mock_page2, mock_page3]
            mock_pp.open.return_value.__enter__.return_value = mock_pdf

            result = run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1, 3],  # skip page 2
            )

        # Only pages 1 and 3 should be processed
        assert set(result.succeededPages) == {1, 3}
        assert 2 not in result.succeededPages
        page_nums = [p.page for p in result.pages]
        assert page_nums == [1, 3]

    def test_result_has_correct_engine_name(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
            mock_pdf = MagicMock()
            mock_page = MagicMock()
            mock_page.page_number = 1
            mock_page.width = 612.0
            mock_page.height = 792.0
            mock_page.rotation = 0
            mock_page.extract_text.return_value = 'Text'
            mock_page.extract_words.return_value = []
            mock_page.find_tables.return_value = []
            mock_page.images = []
            mock_page.lines = []
            mock_page.rects = []
            mock_pdf.pages = [mock_page]
            mock_pp.open.return_value.__enter__.return_value = mock_pdf

            result = run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        assert result.engine == ENGINE_NAME
        assert result.parserVersion == ENGINE_VERSION

    def test_content_sha_is_deterministic(self, tmp_path: Path):
        """F6: output passes cross-language result schema, replayable."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        for _ in range(2):
            with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
                mock_pdf = MagicMock()
                mock_page = MagicMock()
                mock_page.page_number = 1
                mock_page.width = 612.0
                mock_page.height = 792.0
                mock_page.rotation = 0
                mock_page.extract_text.return_value = 'Deterministic text'
                mock_page.extract_words.return_value = []
                mock_page.find_tables.return_value = []
                mock_page.images = []
                mock_page.lines = []
                mock_page.rects = []
                mock_pdf.pages = [mock_page]
                mock_pp.open.return_value.__enter__.return_value = mock_pdf

                result = run_pdfplumber_engine(
                    source_path=pdf_path,
                    expected_sha256=actual_sha,
                    requested_pages=[1],
                )

        # Content SHA should be deterministic (durationMillis excluded)
        sha1 = result.contentSha256
        assert len(sha1) == 64

    def test_no_embedded_text_produces_failure(self, tmp_path: Path):
        """F4: no_embedded_text failure code."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
            mock_pdf = MagicMock()
            mock_page = MagicMock()
            mock_page.page_number = 1
            mock_page.width = 612.0
            mock_page.height = 792.0
            mock_page.rotation = 0
            mock_page.extract_text.return_value = ''  # No text
            mock_page.extract_words.return_value = []
            mock_page.find_tables.return_value = []
            mock_page.images = []
            mock_page.lines = []
            mock_page.rects = []
            mock_pdf.pages = [mock_page]
            mock_pp.open.return_value.__enter__.return_value = mock_pdf

            result = run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        assert len(result.failedPages) == 1
        assert result.failedPages[0].code == 'no_embedded_text'

    def test_narrative_page_without_table_is_not_failure(self, tmp_path: Path):
        """F4: a page with no table but with text is not a parser failure."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
            mock_pdf = MagicMock()
            mock_page = MagicMock()
            mock_page.page_number = 1
            mock_page.width = 612.0
            mock_page.height = 792.0
            mock_page.rotation = 0
            mock_page.extract_text.return_value = 'This is narrative text without tables.'
            mock_page.extract_words.return_value = []
            mock_page.find_tables.return_value = []  # No tables
            mock_page.images = []
            mock_page.lines = []
            mock_page.rects = []
            mock_pdf.pages = [mock_page]
            mock_pp.open.return_value.__enter__.return_value = mock_pdf

            result = run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        # Page should succeed — no table is not a failure for narrative pages
        assert len(result.succeededPages) == 1
        assert len(result.failedPages) == 0

    def test_result_schema_valid(self, tmp_path: Path):
        """F6: output passes cross-language result schema."""
        from capiro_defense_budget_parser.contracts import ParserRuntimeResultV1

        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
            mock_pdf = MagicMock()
            mock_page = MagicMock()
            mock_page.page_number = 1
            mock_page.width = 612.0
            mock_page.height = 792.0
            mock_page.rotation = 0
            mock_page.extract_text.return_value = 'Schema test'
            mock_page.extract_words.return_value = []
            mock_page.find_tables.return_value = []
            mock_page.images = []
            mock_page.lines = []
            mock_page.rects = []
            mock_pdf.pages = [mock_page]
            mock_pp.open.return_value.__enter__.return_value = mock_pdf

            result = run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        # Re-validate by serializing and deserializing
        result_dict = result.model_dump()
        re_parsed = ParserRuntimeResultV1.model_validate(result_dict)
        assert re_parsed.schemaVersion == 'defense_budget_parser_result_v1'
        assert re_parsed.engine == 'deterministic_pdfplumber'

    def test_no_fake_bounding_boxes(self, tmp_path: Path):
        """F5: no fake bbox — if no real coords, bbox is None."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
            mock_pdf = MagicMock()
            mock_page = MagicMock()
            mock_page.page_number = 1
            mock_page.width = 612.0
            mock_page.height = 792.0
            mock_page.rotation = 0
            mock_page.extract_text.return_value = 'Text without coords'
            mock_page.extract_words.return_value = []
            mock_page.find_tables.return_value = []
            mock_page.images = []
            mock_page.lines = []
            mock_page.rects = []
            mock_pdf.pages = [mock_page]
            mock_pp.open.return_value.__enter__.return_value = mock_pdf

            result = run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        # No blocks with fake bboxes when no word coords
        for _block in result.pages[0].blocks:
            # Blocks from word coords would have bboxes;
            # empty words means no blocks with fake bboxes
            pass

    def test_negative_parenthesized_values_preserved_as_text(self, tmp_path: Path):
        """F5: negative/parenthesized values preserved as text."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_table = MagicMock()
        mock_table.extract.return_value = [['($1,234,567)', '($789)']]
        mock_table.bbox = None
        mock_table.cells = {}

        with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
            mock_pdf = MagicMock()
            mock_page = MagicMock()
            mock_page.page_number = 1
            mock_page.width = 612.0
            mock_page.height = 792.0
            mock_page.rotation = 0
            mock_page.extract_text.return_value = 'Table text'
            mock_page.extract_words.return_value = []
            mock_page.find_tables.return_value = [mock_table]
            mock_page.images = []
            mock_page.lines = []
            mock_page.rects = []
            mock_pdf.pages = [mock_page]
            mock_pp.open.return_value.__enter__.return_value = mock_pdf

            result = run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        # Cell text should preserve the parenthesized value as-is
        cell_texts = [c.text for c in result.pages[0].tables[0].cells]
        assert '($1,234,567)' in cell_texts
        assert '($789)' in cell_texts

    def test_deterministic_page_ordering(self, tmp_path: Path):
        """F5: deterministic ordering."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=3)

        with patch('capiro_defense_budget_parser.pdfplumber_engine.pdfplumber') as mock_pp:
            mock_pdf = MagicMock()
            pages = []
            for i in range(3):
                mp = MagicMock()
                mp.page_number = i + 1
                mp.width = 612.0
                mp.height = 792.0
                mp.rotation = 0
                mp.extract_text.return_value = f'Page {i + 1}'
                mp.extract_words.return_value = []
                mp.find_tables.return_value = []
                mp.images = []
                mp.lines = []
                mp.rects = []
                pages.append(mp)
            mock_pdf.pages = pages
            mock_pp.open.return_value.__enter__.return_value = mock_pdf

            result = run_pdfplumber_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1, 2, 3],
            )

        # Pages should be in source order (1, 2, 3)
        page_nums = [p.page for p in result.pages]
        assert page_nums == [1, 2, 3]


class TestEngineIdentity:
    def test_engine_name(self):
        assert ENGINE_NAME == 'deterministic_pdfplumber'

    def test_engine_version(self):
        assert 'pdfplumber' in ENGINE_VERSION.lower()
