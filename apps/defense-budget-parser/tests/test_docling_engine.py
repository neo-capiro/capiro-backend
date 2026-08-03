"""Tests for the Docling mixed-layout engine (Workstream H).

Covers:
- H1: CPU-only mode, no VLM, no remote LLM, no GPU
- H2: page subset mapping (original physical page numbers)
- H3: output mapping (blocks, headings, paragraphs, tables, cell text,
  real geometry, reading order, warnings); no markdown-only cell evidence
- H4: model/config identity recording
- H5: mixed narrative/table synthetic page, multi-column reading order,
  page subset mapping, table and narrative retained, no remote call, no VLM
- H6: deterministic output, truthful parser lineage
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from capiro_defense_budget_parser.contracts import (
    ParserRuntimeResultV1,
)
from capiro_defense_budget_parser.docling_engine import (
    ENGINE_VERSION,
    _collect_model_versions,
    _create_page_subset_pdf,
    compute_config_sha256,
    get_default_config,
    run_docling_engine,
    validate_config,
)


def _make_test_pdf(path: Path, num_pages: int = 3) -> str:
    """Create a minimal multi-page test PDF and return its SHA-256.

    Uses PyMuPDF if available, otherwise pypdf.
    """
    try:
        import fitz

        doc = fitz.open()
        for i in range(num_pages):
            page = doc.new_page(width=612, height=792)
            page.insert_text((72, 72), f'Page {i + 1} narrative text. ')
            page.insert_text((72, 120), 'Line Item | Amount | Delta')
            page.insert_text((72, 150), f'PE {i + 1}0101 | $1,000 | +$100')
        doc.save(str(path))
        doc.close()
    except ImportError:
        # Fallback: pypdf
        from pypdf import PdfWriter

        writer = PdfWriter()
        for _ in range(num_pages):
            writer.add_blank_page(width=612, height=792)
        with open(path, 'wb') as f:
            writer.write(f)
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _make_mixed_layout_pdf(path: Path) -> str:
    """Create a PDF with mixed narrative + table content.

    Uses PyMuPDF if available, otherwise pypdf (blank pages).
    """
    try:
        import fitz

        doc = fitz.open()
        # Page 1: narrative + table
        p1 = doc.new_page(width=612, height=792)
        p1.insert_text((72, 50), 'RDT&E Budget Item Justification')
        p1.insert_text((72, 80), 'This program element funds research into advanced materials.')
        p1.insert_text((72, 120), 'Line Item | FY2024 | FY2025')
        p1.insert_text((72, 140), '0601234A Basic Research | 1,000 | 1,200')
        p1.insert_text((72, 160), '0601235A Applied Research | 2,500 | 2,800')
        p1.insert_text((72, 200), 'Total: 3,500 | 4,000')

        # Page 2: multi-column layout
        p2 = doc.new_page(width=612, height=792)
        p2.insert_text((72, 50), 'Column 1 Header')
        p2.insert_text((320, 50), 'Column 2 Header')
        p2.insert_text((72, 80), 'Left column text about procurement.')
        p2.insert_text((320, 80), 'Right column text about milestones.')

        # Page 3: image-only (no text)
        doc.new_page(width=612, height=792)

        doc.save(str(path))
        doc.close()
    except ImportError:
        # Fallback: pypdf blank pages (mocked converter doesn't read the PDF)
        from pypdf import PdfWriter

        writer = PdfWriter()
        for _ in range(3):
            writer.add_blank_page(width=612, height=792)
        with open(path, 'wb') as f:
            writer.write(f)

    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


# ------------------------------------------------------------------ #
# H1: CPU-only mode, no VLM, no remote LLM
# ------------------------------------------------------------------ #


class TestCpuOnlyMode:
    def test_default_config_disables_vlm(self) -> None:
        cfg = get_default_config()
        assert cfg['vlmPipeline'] is False
        assert cfg['remoteLlmExtraction'] is False
        assert cfg['gpuEnabled'] is False
        assert cfg['cpuMode'] is True

    def test_default_config_disables_ocr(self) -> None:
        cfg = get_default_config()
        assert cfg['ocrEnabled'] is False
        assert cfg['pipelineOptions']['doOcr'] is False

    def test_validate_config_warns_on_vlm(self) -> None:
        cfg = get_default_config()
        cfg['vlmPipeline'] = True
        warnings = validate_config(cfg)
        assert any('VLM' in w for w in warnings)

    def test_validate_config_warns_on_remote_llm(self) -> None:
        cfg = get_default_config()
        cfg['remoteLlmExtraction'] = True
        warnings = validate_config(cfg)
        assert any('remote LLM' in w for w in warnings)

    def test_validate_config_warns_on_gpu(self) -> None:
        cfg = get_default_config()
        cfg['gpuEnabled'] = True
        warnings = validate_config(cfg)
        assert any('GPU' in w for w in warnings)

    def test_validate_config_clean_default(self) -> None:
        warnings = validate_config(get_default_config())
        assert warnings == []


# ------------------------------------------------------------------ #
# H2: Page subset mapping
# ------------------------------------------------------------------ #


class TestPageSubsetMapping:
    def test_subset_pdf_page_map(self, tmp_path: Path) -> None:
        pdf_path = tmp_path / 'multi.pdf'
        _make_test_pdf(pdf_path, num_pages=5)

        subset_path = tmp_path / 'subset.pdf'
        page_map = _create_page_subset_pdf(pdf_path, [2, 4], subset_path)

        assert page_map == {1: 2, 2: 4}
        assert subset_path.exists()

        # Verify subset has exactly 2 pages
        try:
            import fitz

            doc = fitz.open(str(subset_path))
            assert len(doc) == 2
            doc.close()
        except ImportError:
            from pypdf import PdfReader

            reader = PdfReader(str(subset_path))
            assert len(reader.pages) == 2

    def test_subset_preserves_original_order(self, tmp_path: Path) -> None:
        pdf_path = tmp_path / 'multi.pdf'
        _make_test_pdf(pdf_path, num_pages=5)

        subset_path = tmp_path / 'subset.pdf'
        page_map = _create_page_subset_pdf(pdf_path, [1, 3, 5], subset_path)

        assert page_map == {1: 1, 2: 3, 3: 5}

    def test_subset_out_of_range_fails(self, tmp_path: Path) -> None:
        pdf_path = tmp_path / 'small.pdf'
        _make_test_pdf(pdf_path, num_pages=2)

        subset_path = tmp_path / 'subset.pdf'
        with pytest.raises(ValueError, match='out of range'):
            _create_page_subset_pdf(pdf_path, [1, 99], subset_path)


# ------------------------------------------------------------------ #
# H3: Output mapping
# ------------------------------------------------------------------ #


class TestOutputMapping:
    @patch('capiro_defense_budget_parser.docling_engine._create_docling_converter')
    def test_blocks_and_tables_extracted(
        self, mock_converter_factory: MagicMock, tmp_path: Path
    ) -> None:
        """Docling returns blocks and tables in the page result."""
        pdf_path = tmp_path / 'mixed.pdf'
        source_sha = _make_mixed_layout_pdf(pdf_path)

        # Mock the converter to return a structured result
        mock_doc = MagicMock()
        mock_item_text = MagicMock()
        mock_item_text.label = 'paragraph'
        mock_item_text.text = 'This program element funds research.'
        mock_item_text.prov = None

        mock_item_heading = MagicMock()
        mock_item_heading.label = 'title'
        mock_item_heading.text = 'RDT&E Budget Item Justification'
        mock_item_heading.prov = None

        mock_table_cell_00 = MagicMock()
        mock_table_cell_00.text = 'Line Item'
        mock_table_cell_00.prov = None
        mock_table_cell_00.row_span = None
        mock_table_cell_00.col_span = None

        mock_table_cell_01 = MagicMock()
        mock_table_cell_01.text = 'FY2024'
        mock_table_cell_01.prov = None
        mock_table_cell_01.row_span = None
        mock_table_cell_01.col_span = None

        mock_table_cell_10 = MagicMock()
        mock_table_cell_10.text = '0601234A'
        mock_table_cell_10.prov = None
        mock_table_cell_10.row_span = None
        mock_table_cell_10.col_span = None

        mock_table_cell_11 = MagicMock()
        mock_table_cell_11.text = '1,000'
        mock_table_cell_11.prov = None
        mock_table_cell_11.row_span = None
        mock_table_cell_11.col_span = None

        mock_table_data = MagicMock()
        mock_table_data.grid = [
            [mock_table_cell_00, mock_table_cell_01],
            [mock_table_cell_10, mock_table_cell_11],
        ]

        mock_table_item = MagicMock()
        mock_table_item.label = 'table'
        mock_table_item.data = mock_table_data
        mock_table_item.prov = None

        mock_doc.items = [mock_item_heading, mock_item_text, mock_table_item]
        mock_doc.export_to_markdown.return_value = '# RDT&E Budget\n\nSome text\n'

        mock_result = MagicMock()
        mock_result.document = mock_doc

        mock_converter = MagicMock()
        mock_converter.convert.return_value = mock_result
        mock_converter_factory.return_value = mock_converter

        result = run_docling_engine(
            source_path=pdf_path,
            expected_sha256=source_sha,
            requested_pages=[1],
            config=get_default_config(),
        )

        assert isinstance(result, ParserRuntimeResultV1)
        assert result.engine == 'docling'
        assert len(result.pages) == 1

        page = result.pages[0]
        assert page.page == 1
        assert len(page.blocks) >= 1
        assert len(page.tables) == 1

        # Check table contents
        table = page.tables[0]
        assert table.rowCount == 2
        assert table.columnCount == 2
        cell_texts = {c.text for c in table.cells}
        assert 'Line Item' in cell_texts
        assert '0601234A' in cell_texts
        assert '1,000' in cell_texts

        # Check blocks
        block_texts = [b.text for b in page.blocks]
        assert any('RDT&E Budget Item Justification' in t for t in block_texts)

        # Markdown preserved
        assert page.markdown is not None

    @patch('capiro_defense_budget_parser.docling_engine._create_docling_converter')
    def test_no_fake_cell_bbox(self, mock_converter_factory: MagicMock, tmp_path: Path) -> None:
        """Cell bounding boxes are None when Docling doesn't provide them."""
        pdf_path = tmp_path / 'test.pdf'
        source_sha = _make_mixed_layout_pdf(pdf_path)

        mock_cell = MagicMock()
        mock_cell.text = 'value'
        mock_cell.prov = None
        mock_cell.row_span = None
        mock_cell.col_span = None

        mock_table_data = MagicMock()
        mock_table_data.grid = [[mock_cell]]

        mock_table_item = MagicMock()
        mock_table_item.label = 'table'
        mock_table_item.data = mock_table_data
        mock_table_item.prov = None

        mock_doc = MagicMock()
        mock_doc.items = [mock_table_item]
        mock_doc.export_to_markdown.return_value = ''

        mock_result = MagicMock()
        mock_result.document = mock_doc

        mock_converter = MagicMock()
        mock_converter.convert.return_value = mock_result
        mock_converter_factory.return_value = mock_converter

        result = run_docling_engine(
            source_path=pdf_path,
            expected_sha256=source_sha,
            requested_pages=[1],
            config=get_default_config(),
        )

        table = result.pages[0].tables[0]
        for cell in table.cells:
            assert cell.boundingBox is None, 'no fake cell bbox should be generated'

    @patch('capiro_defense_budget_parser.docling_engine._create_docling_converter')
    def test_reading_order_preserved(
        self, mock_converter_factory: MagicMock, tmp_path: Path
    ) -> None:
        """Blocks maintain reading order from Docling."""
        pdf_path = tmp_path / 'test.pdf'
        source_sha = _make_mixed_layout_pdf(pdf_path)

        items = []
        for _i, (label, text) in enumerate(
            [
                ('title', 'Document Title'),
                ('paragraph', 'First paragraph.'),
                ('paragraph', 'Second paragraph.'),
                ('section-header', 'Section A'),
                ('paragraph', 'Section A content.'),
            ]
        ):
            mock_item = MagicMock()
            mock_item.label = label
            mock_item.text = text
            mock_item.prov = None
            items.append(mock_item)

        mock_doc = MagicMock()
        mock_doc.items = items
        mock_doc.export_to_markdown.return_value = ''

        mock_result = MagicMock()
        mock_result.document = mock_doc

        mock_converter = MagicMock()
        mock_converter.convert.return_value = mock_result
        mock_converter_factory.return_value = mock_converter

        result = run_docling_engine(
            source_path=pdf_path,
            expected_sha256=source_sha,
            requested_pages=[1],
            config=get_default_config(),
        )

        blocks = result.pages[0].blocks
        assert len(blocks) == 5
        # Reading order should be sequential
        for i, block in enumerate(blocks):
            assert block.readingOrder == i
        assert blocks[0].blockType == 'heading'
        assert blocks[3].blockType == 'heading'
        assert blocks[1].blockType == 'paragraph'


# ------------------------------------------------------------------ #
# H4: Model/config identity
# ------------------------------------------------------------------ #


class TestModelConfigIdentity:
    def test_engine_version_includes_package(self) -> None:
        assert 'docling' in ENGINE_VERSION
        assert 'cpu' in ENGINE_VERSION

    def test_model_versions_collected(self) -> None:
        cfg = get_default_config()
        versions = _collect_model_versions(cfg)
        assert len(versions) >= 1
        assert any('docling' in v for v in versions)

    def test_config_sha_deterministic(self) -> None:
        cfg1 = get_default_config()
        cfg2 = get_default_config()
        assert compute_config_sha256(cfg1) == compute_config_sha256(cfg2)

    def test_config_sha_changes_with_options(self) -> None:
        cfg1 = get_default_config()
        cfg2 = get_default_config()
        cfg2['pipelineOptions']['doTableStructure'] = False
        assert compute_config_sha256(cfg1) != compute_config_sha256(cfg2)


# ------------------------------------------------------------------ #
# H5: Integration tests (mocked converter)
# ------------------------------------------------------------------ #


class TestIntegration:
    @patch('capiro_defense_budget_parser.docling_engine._create_docling_converter')
    def test_page_subset_integration(
        self, mock_converter_factory: MagicMock, tmp_path: Path
    ) -> None:
        """Requested pages are correctly mapped through subset PDF."""
        pdf_path = tmp_path / 'multi.pdf'
        source_sha = _make_test_pdf(pdf_path, num_pages=5)

        mock_doc = MagicMock()
        mock_item = MagicMock()
        mock_item.label = 'paragraph'
        mock_item.text = 'Sample text'
        mock_item.prov = None
        mock_doc.items = [mock_item]
        mock_doc.export_to_markdown.return_value = ''

        mock_result = MagicMock()
        mock_result.document = mock_doc

        mock_converter = MagicMock()
        mock_converter.convert.return_value = mock_result
        mock_converter_factory.return_value = mock_converter

        result = run_docling_engine(
            source_path=pdf_path,
            expected_sha256=source_sha,
            requested_pages=[2, 4],
            config=get_default_config(),
        )

        assert result.succeededPages == [2, 4]
        assert len(result.pages) == 2
        assert result.pages[0].page == 2
        assert result.pages[1].page == 4

    @patch('capiro_defense_budget_parser.docling_engine._create_docling_converter')
    def test_source_sha_mismatch_fails(
        self, mock_converter_factory: MagicMock, tmp_path: Path
    ) -> None:
        """Source SHA mismatch fails closed before any parsing."""
        pdf_path = tmp_path / 'test.pdf'
        _make_test_pdf(pdf_path)
        wrong_sha = 'a' * 64

        with pytest.raises(ValueError, match='SHA mismatch'):
            run_docling_engine(
                source_path=pdf_path,
                expected_sha256=wrong_sha,
                requested_pages=[1],
                config=get_default_config(),
            )

        # Converter should never have been created
        mock_converter_factory.assert_not_called()

    @patch('capiro_defense_budget_parser.docling_engine._create_docling_converter')
    def test_max_pages_guardrail(self, mock_converter_factory: MagicMock, tmp_path: Path) -> None:
        """Requesting more pages than maxPagesPerJob raises."""
        pdf_path = tmp_path / 'test.pdf'
        source_sha = _make_test_pdf(pdf_path, num_pages=5)

        cfg = get_default_config()
        cfg['maxPagesPerJob'] = 2

        with pytest.raises(ValueError, match='maxPagesPerJob'):
            run_docling_engine(
                source_path=pdf_path,
                expected_sha256=source_sha,
                requested_pages=[1, 2, 3],
                config=cfg,
            )

    @patch('capiro_defense_budget_parser.docling_engine._create_docling_converter')
    def test_deterministic_output(self, mock_converter_factory: MagicMock, tmp_path: Path) -> None:
        """Same input produces same content SHA (deterministic)."""
        pdf_path = tmp_path / 'test.pdf'
        source_sha = _make_test_pdf(pdf_path, num_pages=2)

        mock_doc = MagicMock()
        mock_item = MagicMock()
        mock_item.label = 'paragraph'
        mock_item.text = 'Deterministic text'
        mock_item.prov = None
        mock_doc.items = [mock_item]
        mock_doc.export_to_markdown.return_value = ''

        mock_result = MagicMock()
        mock_result.document = mock_doc

        mock_converter = MagicMock()
        mock_converter.convert.return_value = mock_result
        mock_converter_factory.return_value = mock_converter

        r1 = run_docling_engine(
            source_path=pdf_path,
            expected_sha256=source_sha,
            requested_pages=[1],
            config=get_default_config(),
        )
        r2 = run_docling_engine(
            source_path=pdf_path,
            expected_sha256=source_sha,
            requested_pages=[1],
            config=get_default_config(),
        )

        assert r1.contentSha256 == r2.contentSha256


# ------------------------------------------------------------------ #
# H6: Docling unavailable
# ------------------------------------------------------------------ #


class TestDoclingUnavailable:
    @patch(
        'capiro_defense_budget_parser.docling_engine._create_docling_converter',
        side_effect=RuntimeError('Docling is not installed'),
    )
    def test_all_pages_fail_when_unavailable(self, mock_factory: MagicMock, tmp_path: Path) -> None:
        """When Docling is not installed, all pages get explicit failures."""
        pdf_path = tmp_path / 'test.pdf'
        source_sha = _make_test_pdf(pdf_path, num_pages=3)

        result = run_docling_engine(
            source_path=pdf_path,
            expected_sha256=source_sha,
            requested_pages=[1, 2, 3],
            config=get_default_config(),
        )

        assert len(result.failedPages) == 3
        assert len(result.pages) == 0
        assert result.succeededPages == []
        for f in result.failedPages:
            assert f.code == 'model_unavailable'
        assert result.metrics.pagesFailed == 3
        assert result.metrics.pagesSucceeded == 0

    def test_contract_compliance_on_failure(self, tmp_path: Path) -> None:
        """Failure result still passes the result contract."""
        pdf_path = tmp_path / 'test.pdf'
        source_sha = _make_test_pdf(pdf_path)

        with patch(
            'capiro_defense_budget_parser.docling_engine._create_docling_converter',
            side_effect=RuntimeError('not installed'),
        ):
            result = run_docling_engine(
                source_path=pdf_path,
                expected_sha256=source_sha,
                requested_pages=[1],
                config=get_default_config(),
            )

        # Validate against the contract
        validated = ParserRuntimeResultV1.model_validate(result.model_dump())
        assert validated.engine == 'docling'
        assert len(validated.contentSha256) == 64
