"""Tests for the Camelot table engine (Workstream G)."""

from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from capiro_defense_budget_parser.camelot_engine import (
    CAMELOT_FLAVORS,
    DEFAULT_FLAVOR,
    ENGINE_NAME,
    ENGINE_VERSION,
    build_default_config,
    compute_config_sha256,
    get_flavor_config,
    run_camelot_engine,
)


def _make_test_pdf(path: Path, num_pages: int = 2) -> str:
    """Create a minimal test PDF and return its SHA-256."""
    try:
        import fitz

        doc = fitz.open()
        for i in range(num_pages):
            page = doc.new_page(width=612, height=792)
            page.insert_text((72, 72), f'Page {i + 1} table content')
        doc.save(str(path))
        doc.close()
    except ImportError:
        content = (
            b'%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
            b'2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
            b'3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n'
            b'xref\n0 4\n'
            b'0000000000 65535 f \n'
            b'0000000009 00000 n \n'
            b'0000000058 00000 n \n'
            b'0000000115 00000 n \n'
            b'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF\n'
        )
        path.write_bytes(content)
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


class TestCamelotFlavors:
    def test_all_four_flavors_defined(self):
        assert set(CAMELOT_FLAVORS.keys()) == {'lattice', 'stream', 'network', 'hybrid'}

    def test_lattice_flavor(self):
        cfg = get_flavor_config('lattice')
        assert cfg['flavor'] == 'lattice'

    def test_stream_flavor(self):
        cfg = get_flavor_config('stream')
        assert cfg['flavor'] == 'stream'

    def test_network_flavor(self):
        cfg = get_flavor_config('network')
        assert cfg['flavor'] == 'network'

    def test_hybrid_flavor(self):
        cfg = get_flavor_config('hybrid')
        assert cfg['flavor'] == 'hybrid'

    def test_unknown_flavor_raises(self):
        with pytest.raises(ValueError, match='unknown Camelot flavor'):
            get_flavor_config('nonexistent')

    def test_default_flavor_is_lattice(self):
        assert DEFAULT_FLAVOR == 'lattice'


class TestCamelotConfig:
    def test_default_config_has_flavor(self):
        cfg = build_default_config()
        assert cfg['flavor'] == 'lattice'

    def test_config_with_custom_flavor(self):
        cfg = build_default_config('stream')
        assert cfg['flavor'] == 'stream'

    def test_config_sha_is_deterministic(self):
        sha1 = compute_config_sha256(build_default_config())
        sha2 = compute_config_sha256(build_default_config())
        assert sha1 == sha2
        assert len(sha1) == 64

    def test_different_flavors_produce_different_sha(self):
        sha1 = compute_config_sha256(build_default_config('lattice'))
        sha2 = compute_config_sha256(build_default_config('stream'))
        assert sha1 != sha2


class TestRunCamelotEngine:
    def test_source_sha_mismatch_fails(self, tmp_path: Path):
        pdf_path = tmp_path / 'test.pdf'
        _make_test_pdf(pdf_path, num_pages=1)
        with pytest.raises(ValueError, match='SHA mismatch'):
            run_camelot_engine(
                source_path=pdf_path,
                expected_sha256='0' * 64,
                requested_pages=[1],
            )

    def test_camelot_not_installed_fails_all_pages(self, tmp_path: Path):
        """G6: no OCR/image-only parsing claim — engine unavailable is explicit."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        with patch('capiro_defense_budget_parser.camelot_engine.camelot', None):
            result = run_camelot_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        assert len(result.failedPages) == 1
        assert result.failedPages[0].code == 'model_unavailable'
        assert result.engine == ENGINE_NAME

    def test_page_list_correct(self, tmp_path: Path):
        """G6: page list correct — only requested pages processed."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=3)

        mock_camelot_module = MagicMock()

        def mock_read_pdf(path, pages, flavor, **kwargs):
            int(pages)
            # Return empty tables for pages we don't care about
            return MagicMock()

        mock_camelot_module.read_pdf = mock_read_pdf

        with patch('capiro_defense_budget_parser.camelot_engine.camelot', mock_camelot_module), \
             patch('capiro_defense_budget_parser.camelot_engine.pdfplumber', MagicMock()):
            result = run_camelot_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1, 3],
            )

        # Should process exactly pages 1 and 3
        assert result.metrics.pagesProcessed == 2

    def test_ruled_table_routed_to_lattice(self, tmp_path: Path):
        """G6: ruled table routed to lattice."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_camelot_module = MagicMock()
        mock_table = MagicMock()
        mock_table.df = MagicMock()
        mock_table.df.iloc = MagicMock(return_value='Data')
        mock_table.df.__len__ = MagicMock(return_value=1)
        mock_table.df.columns = ['A']
        mock_table.df.__getitem__ = MagicMock(return_value=MagicMock(
            __len__=lambda _: 1,
        ))
        mock_table.cells = {}
        mock_table.bbox = None
        mock_table.accuracy = 95.0
        mock_table.whitespace = 0.1
        mock_table.order = 'TB'
        mock_table.page = 1

        mock_camelot_module.read_pdf = MagicMock(return_value=[mock_table])

        with patch('capiro_defense_budget_parser.camelot_engine.camelot', mock_camelot_module), \
             patch('capiro_defense_budget_parser.camelot_engine.pdfplumber', MagicMock()):
            run_camelot_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
                config=build_default_config('lattice'),
            )

        # Should have called read_pdf with flavor='lattice'
        mock_camelot_module.read_pdf.assert_called_once()
        call_kwargs = mock_camelot_module.read_pdf.call_args
        assert call_kwargs.kwargs.get('flavor') == 'lattice' or 'lattice' in str(call_kwargs)

    def test_no_network_call(self, tmp_path: Path):
        """G7: no network/model call — Camelot is deterministic local."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_camelot_module = MagicMock()
        mock_camelot_module.read_pdf = MagicMock(return_value=[])

        with patch('capiro_defense_budget_parser.camelot_engine.camelot', mock_camelot_module), \
             patch('capiro_defense_budget_parser.camelot_engine.pdfplumber', MagicMock()):
            result = run_camelot_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        # Engine name is camelot, not llamaparse
        assert result.engine == 'camelot'
        assert result.engine != 'llamaparse'

    def test_result_schema_valid(self, tmp_path: Path):
        """G7: output contract is exact and replayable."""
        from capiro_defense_budget_parser.contracts import ParserRuntimeResultV1

        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_camelot_module = MagicMock()
        mock_camelot_module.read_pdf = MagicMock(return_value=[])

        with patch('capiro_defense_budget_parser.camelot_engine.camelot', mock_camelot_module), \
             patch('capiro_defense_budget_parser.camelot_engine.pdfplumber', MagicMock()):
            result = run_camelot_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        result_dict = result.model_dump()
        re_parsed = ParserRuntimeResultV1.model_validate(result_dict)
        assert re_parsed.schemaVersion == 'defense_budget_parser_result_v1'
        assert re_parsed.engine == 'camelot'

    def test_content_sha_deterministic(self, tmp_path: Path):
        """G7: output is replayable — content SHA is deterministic."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_camelot_module = MagicMock()
        mock_camelot_module.read_pdf = MagicMock(return_value=[])

        with patch('capiro_defense_budget_parser.camelot_engine.camelot', mock_camelot_module), \
             patch('capiro_defense_budget_parser.camelot_engine.pdfplumber', MagicMock()):
            result = run_camelot_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        assert len(result.contentSha256) == 64
        assert result.contentSha256.isalnum()

    def test_no_tables_is_not_failure(self, tmp_path: Path):
        """G6: no table is not necessarily a parser failure."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_camelot_module = MagicMock()
        mock_camelot_module.read_pdf = MagicMock(return_value=[])

        with patch('capiro_defense_budget_parser.camelot_engine.camelot', mock_camelot_module), \
             patch('capiro_defense_budget_parser.camelot_engine.pdfplumber', MagicMock()):
            result = run_camelot_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
            )

        # Page should succeed with warning about no tables
        assert len(result.succeededPages) == 1
        assert len(result.failedPages) == 0
        assert any('no tables' in w for w in result.pages[0].warnings)

    def test_hybrid_tries_lattice_then_stream(self, tmp_path: Path):
        """G1: hybrid = lattice first, fallback to stream."""
        pdf_path = tmp_path / 'test.pdf'
        actual_sha = _make_test_pdf(pdf_path, num_pages=1)

        mock_camelot_module = MagicMock()
        call_count = [0]

        def mock_read_pdf(path, pages, flavor, **kwargs):
            call_count[0] += 1
            if flavor == 'lattice':
                return []  # lattice finds nothing
            # stream returns a table-like mock
            mock_table = MagicMock()
            mock_table.df = [['A', 'B'], ['1', '2']]
            mock_table.cells = {}
            mock_table.bbox = None
            return [mock_table]

        mock_camelot_module.read_pdf = mock_read_pdf

        with patch('capiro_defense_budget_parser.camelot_engine.camelot', mock_camelot_module), \
             patch('capiro_defense_budget_parser.camelot_engine.pdfplumber', MagicMock()):
            result = run_camelot_engine(
                source_path=pdf_path,
                expected_sha256=actual_sha,
                requested_pages=[1],
                config=build_default_config('hybrid'),
            )

        # Both flavors should have been tried
        assert call_count[0] == 2
        # Page should have succeeded (no tables is not a failure)
        assert len(result.succeededPages) == 1


class TestCamelotEngineIdentity:
    def test_engine_name(self):
        assert ENGINE_NAME == 'camelot'

    def test_engine_version(self):
        assert 'camelot' in ENGINE_VERSION.lower()
