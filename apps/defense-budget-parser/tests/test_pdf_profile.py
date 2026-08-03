"""Tests for the PDF page profiler."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest

from capiro_defense_budget_parser.pdf_profile import (
    DEFAULT_THRESHOLDS,
    compute_profiling_config_sha256,
    compute_file_sha256,
    verify_source_sha256,
    profile_page,
    build_summary,
    _to_decimal_string,
    _alphanumeric_count,
    _word_count,
    _is_table_like_line,
)


class TestThresholds:
    def test_default_thresholds(self):
        assert DEFAULT_THRESHOLDS["minimumEmbeddedTextCharacters"] == 40
        assert DEFAULT_THRESHOLDS["imageOnlyAreaRatio"] == 0.80
        assert DEFAULT_THRESHOLDS["minimumTableLikeTextLines"] == 3

    def test_deterministic_config_sha(self):
        sha1 = compute_profiling_config_sha256(DEFAULT_THRESHOLDS)
        sha2 = compute_profiling_config_sha256(DEFAULT_THRESHOLDS)
        assert sha1 == sha2
        assert len(sha1) == 64

    def test_different_thresholds_different_sha(self):
        modified = dict(DEFAULT_THRESHOLDS)
        modified["minimumEmbeddedTextCharacters"] = 50
        sha1 = compute_profiling_config_sha256(DEFAULT_THRESHOLDS)
        sha2 = compute_profiling_config_sha256(modified)
        assert sha1 != sha2


class TestSourceIntegrity:
    def test_compute_file_sha256(self, tmp_path: Path):
        p = tmp_path / "test.txt"
        p.write_text("hello world")
        sha = compute_file_sha256(p)
        expected = hashlib.sha256(b"hello world").hexdigest()
        assert sha == expected

    def test_verify_source_sha256_match(self, tmp_path: Path):
        p = tmp_path / "test.txt"
        p.write_text("hello world")
        expected = hashlib.sha256(b"hello world").hexdigest()
        # Should not raise
        verify_source_sha256(p, expected)

    def test_verify_source_sha256_mismatch(self, tmp_path: Path):
        p = tmp_path / "test.txt"
        p.write_text("hello world")
        wrong = "0" * 64
        with pytest.raises(ValueError, match="source SHA mismatch"):
            verify_source_sha256(p, wrong)


class TestHelpers:
    def test_to_decimal_string_whole(self):
        assert _to_decimal_string(612.0) == "612"

    def test_to_decimal_string_fractional(self):
        assert _to_decimal_string(612.5) == "612.5"

    def test_alphanumeric_count(self):
        assert _alphanumeric_count("abc123") == 6
        assert _alphanumeric_count("  !  ") == 0

    def test_word_count(self):
        assert _word_count("hello world") == 2
        assert _word_count("") == 0

    def test_is_table_like_line(self):
        assert _is_table_like_line("1000 2000 3000")
        assert _is_table_like_line("PE Code FY 2025")
        assert not _is_table_like_line("just text")
        assert not _is_table_like_line("")


class TestProfilePage:
    """Test profile_page with a mock page object."""

    def _make_mock_page(
        self,
        page_number: int = 1,
        width: float = 612.0,
        height: float = 792.0,
        rotation: int = 0,
        text: str = "",
        images: list[dict] | None = None,
        lines: list[dict] | None = None,
        rects: list[dict] | None = None,
    ) -> Any:
        class MockPage:
            def __init__(self):
                self.page_number = page_number
                self.width = width
                self.height = height
                self.rotation = rotation
                self.images = images or []
                self.lines = lines or []
                self.rects = rects or []

            def extract_text(self) -> str:
                return text

        return MockPage()

    def test_clean_text_page(self):
        page = self._make_mock_page(
            text="Program Element 0601101D8Z FY 2025 12500 thousands",
        )
        profile = profile_page(page, DEFAULT_THRESHOLDS)
        assert profile["page"] == 1
        assert profile["hasEmbeddedTextLayer"] is True
        assert profile["likelyImageOnly"] is False
        assert profile["likelyRotated"] is False

    def test_image_only_page(self):
        page = self._make_mock_page(
            text="",
            images=[{"x0": 0, "x1": 612, "top": 0, "bottom": 792}],
        )
        profile = profile_page(page, DEFAULT_THRESHOLDS)
        assert profile["hasEmbeddedTextLayer"] is False
        assert profile["likelyImageOnly"] is True

    def test_rotated_page(self):
        page = self._make_mock_page(rotation=90)
        profile = profile_page(page, DEFAULT_THRESHOLDS)
        assert profile["likelyRotated"] is True

    def test_table_page_with_lines(self):
        page = self._make_mock_page(
            text="Col A Col B Col C\n100 200 300\n400 500 600\n700 800 900",
            lines=[
                {"x0": 0, "x1": 600, "top": 100, "bottom": 100},
                {"x0": 0, "x1": 600, "top": 200, "bottom": 200},
                {"x0": 0, "x1": 0, "top": 100, "bottom": 200},
                {"x0": 200, "x1": 200, "top": 100, "bottom": 200},
                {"x0": 400, "x1": 400, "top": 100, "bottom": 200},
                {"x0": 600, "x1": 600, "top": 100, "bottom": 200},
            ],
        )
        profile = profile_page(page, DEFAULT_THRESHOLDS)
        assert profile["likelyTablePage"] is True
        assert profile["vectorLineCount"] == 6

    def test_blank_page(self):
        page = self._make_mock_page(text="", images=[], lines=[], rects=[])
        profile = profile_page(page, DEFAULT_THRESHOLDS)
        assert profile["hasEmbeddedTextLayer"] is False
        assert profile["likelyImageOnly"] is False
        assert profile["embeddedTextCharacters"] == 0


class TestBuildSummary:
    def test_empty_profiles(self):
        summary = build_summary([])
        assert summary["pageCount"] == 0
        assert summary["estimatedLlamaparsePages"] == 0

    def test_mixed_profiles(self):
        profiles = [
            {
                "hasEmbeddedTextLayer": True,
                "likelyImageOnly": False,
                "likelyTablePage": True,
                "likelyMixedLayout": False,
                "likelyRotated": False,
                "embeddedTextCharacters": 500,
                "imageCount": 0,
            },
            {
                "hasEmbeddedTextLayer": False,
                "likelyImageOnly": True,
                "likelyTablePage": False,
                "likelyMixedLayout": False,
                "likelyRotated": False,
                "embeddedTextCharacters": 0,
                "imageCount": 1,
            },
            {
                "hasEmbeddedTextLayer": True,
                "likelyImageOnly": False,
                "likelyTablePage": False,
                "likelyMixedLayout": True,
                "likelyRotated": True,
                "embeddedTextCharacters": 300,
                "imageCount": 1,
            },
        ]
        summary = build_summary(profiles)
        assert summary["pageCount"] == 3
        assert summary["imageOnlyPageCount"] == 1
        assert summary["tableLikelyPageCount"] == 1
        assert summary["mixedLayoutPageCount"] == 1
        assert summary["rotatedPageCount"] == 1
        assert summary["estimatedLlamaparsePages"] == 0