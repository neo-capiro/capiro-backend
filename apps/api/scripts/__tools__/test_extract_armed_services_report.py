import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("extract_armed_services_report.py")
SPEC = importlib.util.spec_from_file_location("extract_armed_services_report", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
extractor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = extractor
SPEC.loader.exec_module(extractor)


class FakePage:
    def __init__(self, text: str) -> None:
        self._text = text

    def extract_text(self) -> str:
        return self._text


class FakeDocument:
    def __init__(self, pages: list[str]) -> None:
        self.pages = [FakePage(page) for page in pages]

class ExtractArmedServicesReportTest(unittest.TestCase):
    def extract(self, pages: list[str], **overrides):
        arguments = {
            "fy": 2027,
            "page_start": 1,
            "page_end": len(pages),
            "unit": "thousands",
            "omit_request": True,
            "page_edge_authorized_sums": frozenset(),
        }
        arguments.update(overrides)
        with patch.object(extractor, "PdfReader", return_value=FakeDocument(pages)):
            return extractor.extract_rows(Path("report.pdf"), **arguments)

    def test_extracts_mark_only_row_with_physical_page_and_unit(self):
        rows, units = self.extract(
            [
                "TITLE XLII—RESEARCH, DEVELOPMENT, TEST, AND EVALUATION\n"
                "(In Thousands of Dollars)\n"
                "001 0601102A Defense Research Sciences 215, 322 225, 322"
            ],
            page_start=1,
            page_end=1,
        )
        self.assertEqual(units, {"thousands"})
        self.assertEqual(
            rows,
            [
                {
                    "peCode": "0601102A",
                    "fy": 2027,
                    "mark": 225322,
                    "markUnit": "thousands",
                    "page": 1,
                    "rowLabel": "001",
                    "explanation": "Defense Research Sciences",
                }
            ],
        )

    def test_rejects_conflicting_printed_unit(self):
        with self.assertRaisesRegex(ValueError, "does not match requested unit"):
            self.extract(["(In Millions of Dollars)\n001 0601102A Item 1 2"])

    def test_preserves_legitimate_repeated_program_elements(self):
        rows, _units = self.extract(
            [
                "(In Thousands of Dollars)\n001 0601102A Item 1 2",
                "002 0601102A Separate service table 3 4",
            ]
        )
        self.assertEqual([row["mark"] for row in rows], [2, 4])

    def test_rejects_duplicate_source_row_identity(self):
        with self.assertRaisesRegex(ValueError, "duplicate source row"):
            self.extract(
                [
                    "(In Thousands of Dollars)\n"
                    "001 0601102A Item 1 1\n"
                    "001 0601102A Duplicated extraction 1 1"
                ]
            )

    def test_repairs_gpo_spacing_wraps_and_truncated_authorized_cell(self):
        rows, _units = self.extract(
            [
                "(In Thousands of Dollars)\n"
                "001 0601102A Wrapped description\ncontinued.\n2,749 2,749\n"
                "002 0601103A Broken amount 154,020 15 4,020\n"
                "003 0601104A Page edge 232,046 7,500\n"
                "VerDate Sep 11 2014"
            ],
            page_edge_authorized_sums=frozenset({(1, "0601104A")}),
        )
        self.assertEqual([row["mark"] for row in rows], [2749, 154020, 239546])

    def test_does_not_synthesize_page_edge_mark_without_explicit_review_rule(self):
        rows, _units = self.extract(
            [
                "(In Thousands of Dollars)\n"
                "003 0601104A Page edge 232,046 7,500\n"
                "VerDate Sep 11 2014"
            ]
        )
        self.assertEqual(rows[0]["mark"], 7500)

    def test_repairs_split_zero_prefix_without_merging_columns(self):
        row = extractor.parse_row(
            "004 1203174SF Space integration 10,538 1 0,538",
            fy=2027,
            page_number=2,
            unit="thousands",
            omit_request=True,
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["mark"], 10538)

    def test_rejects_invalid_range_and_missing_unit(self):
        with self.assertRaisesRegex(ValueError, "page range must be one-based"):
            self.extract(["(In Thousands of Dollars)"], page_start=0, page_end=1)
        with self.assertRaisesRegex(ValueError, "do not contain a printed monetary unit"):
            self.extract(["001 0601102A Item 1 2"])


if __name__ == "__main__":
    unittest.main()
