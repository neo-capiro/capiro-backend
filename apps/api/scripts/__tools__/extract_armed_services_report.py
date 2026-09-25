#!/usr/bin/env python3
"""Extract proof-bound PE rows from an official Armed Services report PDF.

The extractor is intentionally strict: callers must select a physical-page range,
declare the table unit, and identify the official source.  The selected pages must
contain the same printed unit declaration. Repeated PE codes are preserved because
the official report can legitimately list the same PE in separate service tables.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

from pypdf import PdfReader


EXTRACTOR_VERSION = "extract_armed_services_report_v2"
PE_RE = re.compile(
    r"^(?:(?P<line>[0-9]{3})\s+)?(?P<pe>[0-9]{7}[A-Z][A-Z0-9]*)\b(?P<after>.*)$"
)
AMOUNT_RE = re.compile(
    r"(?<![A-Za-z0-9])\(?-?\$?(?:[0-9]{1,3}(?:,\s*[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?\)?(?![A-Za-z0-9])"
)
UNIT_RE = re.compile(r"\(In\s+(Thousands|Millions)\s+of\s+Dollars\)", re.IGNORECASE)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_amount(raw: str) -> float | int:
    normalized = raw.strip()
    negative = normalized.startswith("(") and normalized.endswith(")")
    normalized = normalized.strip("()").replace("$", "").replace(",", "").replace(" ", "")
    value = float(normalized)
    if negative:
        value = -value
    return int(value) if value.is_integer() else value


def detected_units(text: str) -> set[str]:
    return {match.group(1).lower() for match in UNIT_RE.finditer(text)}


def normalize_broken_amount_spacing(text: str) -> str:
    """Repair deterministic GPO glyph-spacing defects inside number tokens."""
    normalized = text.replace("\ufffd", "-").replace("−", "-").replace("–", "-")
    normalized = re.sub(r"(?<=\d)\s+,\s*(?=\d{3}\b)", ",", normalized)

    def join_prefix(match: re.Match[str]) -> str:
        left, right = match.group(1), match.group(2)
        right_prefix = right.split(",", 1)[0]
        return (
            left + right
            if right_prefix.startswith("0") or len(left) + len(right_prefix) == 3
            else match.group(0)
        )

    def join_suffix(match: re.Match[str]) -> str:
        left, right = match.group(1), match.group(2)
        fractional_group = left.rsplit(",", 1)[1]
        return left + right if len(fractional_group) + len(right) == 3 else match.group(0)

    normalized = re.sub(r"\b(\d{1,3},\d{1,2})\s+(\d{1,2})\b", join_suffix, normalized)
    return re.sub(r"\b(\d{1,2})\s+(\d{1,2},\d{3})\b", join_prefix, normalized)


def parse_row(
    line: str,
    *,
    fy: int,
    page_number: int,
    unit: str,
    omit_request: bool,
    infer_page_edge_authorized: bool = False,
) -> dict[str, Any] | None:
    match = PE_RE.match(line.strip())
    if not match:
        return None

    after = normalize_broken_amount_spacing(match.group("after"))
    amounts = list(AMOUNT_RE.finditer(after))
    if not amounts:
        return None

    first_amount = amounts[0]
    parsed_amounts = [parse_amount(amount.group(0)) for amount in amounts]
    mark = parsed_amounts[-1]
    # A changed row normally has request/change/authorized. At the physical
    # page boundary GPO drops the last cell for 0602141A, leaving two unequal
    # values. The authorized amount remains deterministically request + change.
    if (
        infer_page_edge_authorized
        and len(parsed_amounts) == 2
        and parsed_amounts[0] != parsed_amounts[1]
    ):
        mark = parsed_amounts[0] + parsed_amounts[1]

    row: dict[str, Any] = {
        "peCode": match.group("pe"),
        "fy": fy,
        "mark": mark,
        "markUnit": unit,
        "page": page_number,
    }

    line_number = match.group("line")
    if line_number is not None:
        row["rowLabel"] = line_number

    if not omit_request and len(amounts) >= 2:
        row["request"] = parsed_amounts[0]
        row["requestUnit"] = unit

    explanation = after[: first_amount.start()].strip(" .")
    if explanation:
        row["explanation"] = explanation

    return row


def extract_rows(
    pdf_path: Path,
    *,
    fy: int,
    page_start: int,
    page_end: int,
    unit: str,
    omit_request: bool,
    page_edge_authorized_sums: frozenset[tuple[int, str]] = frozenset(),
) -> tuple[list[dict[str, Any]], set[str]]:
    if page_start < 1 or page_end < page_start:
        raise ValueError("page range must be one-based and page_end must be >= page_start")

    rows: list[dict[str, Any]] = []
    selected_units: set[str] = set()
    seen_source_rows: set[tuple[int, str, str]] = set()

    document = PdfReader(pdf_path)
    if page_end > len(document.pages):
        raise ValueError(
            f"page_end {page_end} exceeds document page count {len(document.pages)}"
        )

    for page_number in range(page_start, page_end + 1):
        # GovInfo report glyphs are stored in reverse coordinate order. pypdf
        # applies the page text matrix correctly; pdfplumber returns mirrored
        # tokens for this exact official document.
        text = document.pages[page_number - 1].extract_text() or ""
        selected_units.update(detected_units(text))
        page_lines = text.splitlines()
        for line_index, line in enumerate(page_lines):
            if not PE_RE.match(line.strip()):
                continue
            logical_line = line
            pe_code = PE_RE.match(line.strip()).group("pe")  # guarded immediately above
            next_line_is_footer = (
                line_index + 1 < len(page_lines)
                and page_lines[line_index + 1].lstrip().startswith("VerDate ")
            )
            row = parse_row(
                logical_line,
                fy=fy,
                page_number=page_number,
                unit=unit,
                omit_request=omit_request,
                infer_page_edge_authorized=(
                    next_line_is_footer
                    and (page_number, pe_code) in page_edge_authorized_sums
                ),
            )
            continuation_index = line_index + 1
            while row is None and continuation_index < len(page_lines):
                continuation = page_lines[continuation_index]
                if PE_RE.match(continuation.strip()):
                    break
                logical_line = f"{logical_line} {continuation}"
                row = parse_row(
                    logical_line,
                    fy=fy,
                    page_number=page_number,
                    unit=unit,
                    omit_request=omit_request,
                )
                continuation_index += 1
            if row is None:
                continue
            pe_number = str(row["peCode"])
            row_key = (page_number, str(row.get("rowLabel", "")), pe_number)
            if row_key in seen_source_rows:
                raise ValueError(
                    f"duplicate source row for program element {pe_number} "
                    f"on page {page_number} with label {row_key[1]}"
                )
            seen_source_rows.add(row_key)
            rows.append(row)

    if not selected_units:
        raise ValueError("selected pages do not contain a printed monetary unit declaration")
    if selected_units != {unit}:
        raise ValueError(
            "selected-page unit declaration does not match requested unit: "
            f"detected={sorted(selected_units)}, requested={unit}"
        )
    if not rows:
        raise ValueError("selected pages contain no program-element rows")

    return rows, selected_units


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path, help="Official source PDF")
    parser.add_argument("output", type=Path, help="Output JSON path")
    parser.add_argument("--fy", type=int, required=True)
    parser.add_argument("--page-start", type=int, required=True)
    parser.add_argument("--page-end", type=int, required=True)
    parser.add_argument("--unit", choices=("thousands", "millions"), required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--document-key", required=True)
    parser.add_argument("--retained-s3-uri")
    parser.add_argument("--retained-s3-version-id")
    parser.add_argument("--expected-row-count", type=int, required=True)
    parser.add_argument("--expected-mark-total-dollars", type=int, required=True)
    parser.add_argument(
        "--reference-rows-json",
        type=Path,
        help="Reviewed legacy companion used only for exact PE/mark reconciliation",
    )
    parser.add_argument(
        "--page-edge-authorized-sum",
        action="append",
        default=[],
        metavar="PAGE:PE_CODE",
        help=(
            "Explicit reviewed repair for a page-edge row whose authorized cell is absent; "
            "the two retained request/change values are summed"
        ),
    )
    parser.add_argument(
        "--omit-request",
        action="store_true",
        help="Emit only the committee-owned mark, not the request/reference column",
    )
    return parser


def parse_page_edge_authorized_sums(values: Iterable[str]) -> frozenset[tuple[int, str]]:
    repairs: set[tuple[int, str]] = set()
    for value in values:
        page_raw, separator, pe_code_raw = value.partition(":")
        pe_code = pe_code_raw.strip().upper()
        if separator == "" or not page_raw.isdigit() or PE_RE.fullmatch(pe_code) is None:
            raise ValueError(
                f"invalid --page-edge-authorized-sum {value!r}; expected PAGE:PE_CODE"
            )
        repairs.add((int(page_raw), pe_code))
    return frozenset(repairs)


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    pdf_path = args.pdf.resolve()
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF does not exist: {pdf_path}")

    page_edge_authorized_sums = parse_page_edge_authorized_sums(
        args.page_edge_authorized_sum
    )
    if any(page < args.page_start or page > args.page_end for page, _pe in page_edge_authorized_sums):
        raise ValueError("page-edge repair lies outside the selected page range")
    rows, units = extract_rows(
        pdf_path,
        fy=args.fy,
        page_start=args.page_start,
        page_end=args.page_end,
        unit=args.unit,
        omit_request=args.omit_request,
        page_edge_authorized_sums=page_edge_authorized_sums,
    )
    if (args.retained_s3_uri is None) != (args.retained_s3_version_id is None):
        raise ValueError("retained S3 URI and version ID must be supplied together")
    multiplier = {"thousands": Decimal(1_000), "millions": Decimal(1_000_000)}[
        args.unit
    ]
    mark_total_dollars = sum(Decimal(str(row["mark"])) * multiplier for row in rows)
    if len(rows) != args.expected_row_count:
        raise ValueError(
            f"row-count qualification failed: extracted={len(rows)}, "
            f"expected={args.expected_row_count}"
        )
    if mark_total_dollars != Decimal(args.expected_mark_total_dollars):
        raise ValueError(
            "mark-total qualification failed: "
            f"extracted={mark_total_dollars}, expected={args.expected_mark_total_dollars}"
        )
    reference_companion: dict[str, Any] | None = None
    if args.reference_rows_json is not None:
        reference_path = args.reference_rows_json.resolve()
        reference_payload = json.loads(reference_path.read_text(encoding="utf-8"))
        reference_rows = reference_payload.get("rows")
        if not isinstance(reference_rows, list):
            raise ValueError("reference rows artifact does not contain a rows array")
        extracted_marks = Counter(
            (row["peCode"], Decimal(str(row["mark"])) * multiplier) for row in rows
        )
        reviewed_marks = Counter(
            (str(row.get("peCode", "")).strip().upper(), Decimal(str(row["mark"])))
            for row in reference_rows
        )
        if extracted_marks != reviewed_marks:
            raise ValueError("official PDF rows do not exactly match the reviewed PE/mark multiset")
        reference_companion = {
            "sha256": sha256_file(reference_path),
            "rowCount": len(reference_rows),
            "exactPeMarkMultisetMatch": True,
        }
    source: dict[str, Any] = {
        "url": args.source_url,
        "sha256": sha256_file(pdf_path),
        "pageRange": {
            "start": args.page_start,
            "end": args.page_end,
            "numbering": "physical_pdf_one_based",
        },
        "declaredUnit": args.unit,
        "detectedUnits": sorted(units),
    }
    if args.retained_s3_uri is not None:
        source["retainedObject"] = {
            "uri": args.retained_s3_uri,
            "versionId": args.retained_s3_version_id,
        }
    output = {
        "schema": "governed_congressional_rows_v1",
        "documentKey": args.document_key,
        "fiscalYear": args.fy,
        "source": source,
        "extraction": {
            "extractorVersion": EXTRACTOR_VERSION,
            "parserLibrary": f"pypdf-{importlib.metadata.version('pypdf')}",
            "requestOmitted": args.omit_request,
            "rowCount": len(rows),
            "markTotalDollars": int(mark_total_dollars),
            "qualificationExpectations": {
                "rowCount": args.expected_row_count,
                "markTotalDollars": args.expected_mark_total_dollars,
            },
            "explicitRepairs": [
                {
                    "type": "page_edge_authorized_sum",
                    "page": page,
                    "peCode": pe_code,
                }
                for page, pe_code in sorted(page_edge_authorized_sums)
            ],
            **(
                {"referenceCompanion": reference_companion}
                if reference_companion is not None
                else {}
            ),
        },
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # CLI boundary: fail closed with one deterministic message.
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
