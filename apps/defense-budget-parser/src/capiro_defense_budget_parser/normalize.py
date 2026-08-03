"""capiro_defense_budget_parser.normalize — normalize parser output to V1 contracts.

Shared normalization utilities used by all engines to map raw parser output
into the ParserPageResultV1 contract.
"""

from __future__ import annotations

from typing import Any

from .contracts import (
    BoundingBoxV1,
    LayoutBlockV1,
    ParsedTableCellV1,
    ParsedTableV1,
)


def float_to_decimal_string(value: float) -> str:
    """Convert a float to a canonical decimal string without float artifacts."""
    if value == int(value):
        return str(int(value))
    # Use repr to preserve precision, then strip trailing zeros
    s = repr(value)
    return s


def bbox_from_list(bbox: list[float] | tuple[float, ...] | None) -> BoundingBoxV1 | None:
    """Convert a [x0, y0, x1, y1] list to BoundingBoxV1, or None."""
    if not bbox or len(bbox) != 4:
        return None
    return BoundingBoxV1(
        x0=float_to_decimal_string(float(bbox[0])),
        y0=float_to_decimal_string(float(bbox[1])),
        x1=float_to_decimal_string(float(bbox[2])),
        y1=float_to_decimal_string(float(bbox[3])),
    )


def text_blocks_from_lines(lines: list[str], start_index: int = 0) -> list[LayoutBlockV1]:
    """Convert text lines to LayoutBlockV1 paragraphs."""
    blocks: list[LayoutBlockV1] = []
    for i, line in enumerate(lines):
        if line.strip():
            blocks.append(
                LayoutBlockV1(
                    blockIndex=start_index + i,
                    blockType='text',
                    text=line.strip(),
                    readingOrder=start_index + i,
                )
            )
    return blocks


def table_from_grid(
    grid: list[list[str]],
    table_index: int,
    label: str | None = None,
) -> ParsedTableV1:
    """Build a ParsedTableV1 from a 2D grid of cell text strings."""
    row_count = len(grid)
    col_count = max(len(row) for row in grid) if grid else 0
    cells: list[ParsedTableCellV1] = []
    for r_idx, row in enumerate(grid):
        for c_idx in range(col_count):
            text = row[c_idx] if c_idx < len(row) else ''
            cells.append(
                ParsedTableCellV1(
                    rowIndex=r_idx,
                    columnIndex=c_idx,
                    text=text,
                )
            )
    return ParsedTableV1(
        tableIndex=table_index,
        label=label,
        rowCount=row_count,
        columnCount=col_count,
        cells=cells,
        warnings=[],
    )


def merge_page_text(blocks: list[LayoutBlockV1]) -> str | None:
    """Join block texts into a single page text string."""
    parts = [b.text for b in blocks if b.text]
    return '\n'.join(parts) if parts else None


def safe_confidence(value: Any) -> str | None:
    """Convert a confidence value to a decimal string, or None."""
    if value is None:
        return None
    try:
        f = float(value)
        if f < 0 or f > 1:
            return None
        return float_to_decimal_string(f)
    except (ValueError, TypeError):
        return None
