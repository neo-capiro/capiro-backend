"""capiro_defense_budget_parser.pdf_profile — deterministic PDF page profiler.

Low-cost first pass that inventories document/page characteristics without
extracting canonical budget assertions. No OCR, Docling, PaddleOCR, or
LlamaParse may run during profiling.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .contracts import (
    sha256_canonical_json,
)

# ------------------------------------------------------------------ #
# Profiling thresholds                                               #
# ------------------------------------------------------------------ #

DEFAULT_THRESHOLDS: dict[str, Any] = {
    'minimumEmbeddedTextCharacters': 40,
    'minimumAlphanumericCharacters': 20,
    'imageOnlyAreaRatio': 0.80,
    'rotationDegreesRequiringCorrection': [90, 180, 270, -90, -180, -270],
    'minimumTableLikeTextLines': 3,
    'minimumVectorLinesForTableCue': 6,
}


def compute_profiling_config_sha256(thresholds: dict[str, Any]) -> str:
    return sha256_canonical_json(thresholds)


# ------------------------------------------------------------------ #
# Source integrity                                                   #
# ------------------------------------------------------------------ #


def compute_file_sha256(path: str | Path) -> str:
    """Compute SHA-256 of a file, reading in chunks."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def verify_source_sha256(source_path: str | Path, expected_sha256: str) -> None:
    """Verify the file SHA matches the expected SHA. Raises on mismatch."""
    actual = compute_file_sha256(source_path)
    if actual != expected_sha256:
        raise ValueError(f'source SHA mismatch: expected {expected_sha256}, got {actual}')


# ------------------------------------------------------------------ #
# Page profile record                                                #
# ------------------------------------------------------------------ #


def _to_decimal_string(value: float) -> str:
    """Convert a float to a canonical decimal string."""
    if value == int(value):
        return str(int(value))
    return repr(value)


def _alphanumeric_count(text: str) -> int:
    return sum(1 for c in text if c.isalnum())


def _word_count(text: str) -> int:
    return len(text.split())


def _is_table_like_line(line: str) -> bool:
    """Heuristic: a line with 2+ whitespace-separated runs that include digits."""
    parts = line.split()
    if len(parts) < 2:
        return False
    has_digit = any(any(c.isdigit() for c in p) for p in parts)
    return has_digit and len(parts) >= 2


def profile_page(page: Any, thresholds: dict[str, Any]) -> dict[str, Any]:
    """Profile a single pdfplumber page object."""
    width = float(page.width)
    height = float(page.height)
    rotation = int(getattr(page, 'rotation', 0) or 0)

    # Extract text
    text = page.extract_text() or ''
    embedded_text_chars = len(text)
    alpha_chars = _alphanumeric_count(text)
    word_count = _word_count(text)

    # Images
    images = page.images or []
    image_count = len(images)
    image_area = 0.0
    page_area = width * height
    for img in images:
        img_width = float(img.get('x1', 0)) - float(img.get('x0', 0))
        img_height = float(img.get('top', 0)) - float(img.get('bottom', 0))
        image_area += abs(img_width * img_height)
    image_area_ratio = image_area / page_area if page_area > 0 else 0.0

    # Lines
    lines = page.lines or []
    rects = page.rects or []
    all_lines = list(lines) + list(rects)
    vector_line_count = len(all_lines)
    horizontal_line_count = 0
    vertical_line_count = 0
    for line in all_lines:
        x0 = float(line.get('x0', 0))
        y0 = float(line.get('top', 0))
        x1 = float(line.get('x1', 0))
        y1 = float(line.get('bottom', 0))
        if abs(y1 - y0) < 0.5 and abs(x1 - x0) > 0.5:
            horizontal_line_count += 1
        elif abs(x1 - x0) < 0.5 and abs(y1 - y0) > 0.5:
            vertical_line_count += 1

    # Table-like text lines
    text_lines = text.split('\n') if text else []
    table_like_lines = sum(1 for line in text_lines if _is_table_like_line(line))

    # Classifications
    has_embedded_text = embedded_text_chars >= thresholds['minimumEmbeddedTextCharacters']
    likely_image_only = (
        not has_embedded_text and image_area_ratio >= thresholds['imageOnlyAreaRatio']
    )
    likely_rotated = rotation in thresholds['rotationDegreesRequiringCorrection']
    likely_table = (
        table_like_lines >= thresholds['minimumTableLikeTextLines']
        or vector_line_count >= thresholds['minimumVectorLinesForTableCue']
    )
    likely_mixed = (
        has_embedded_text
        and table_like_lines > 0
        and table_like_lines < thresholds['minimumTableLikeTextLines']
        and image_count > 0
    )

    warnings: list[str] = []
    if not has_embedded_text and not likely_image_only:
        warnings.append('page has low text but below image-only threshold')

    return {
        'page': int(page.page_number),
        'width': _to_decimal_string(width),
        'height': _to_decimal_string(height),
        'rotation': rotation,
        'embeddedTextCharacters': embedded_text_chars,
        'alphanumericCharacters': alpha_chars,
        'wordCount': word_count,
        'imageCount': image_count,
        'imageAreaRatio': _to_decimal_string(image_area_ratio),
        'vectorLineCount': vector_line_count,
        'horizontalLineCount': horizontal_line_count,
        'verticalLineCount': vertical_line_count,
        'tableLikeTextLineCount': table_like_lines,
        'hasEmbeddedTextLayer': has_embedded_text,
        'likelyImageOnly': likely_image_only,
        'likelyRotated': likely_rotated,
        'likelyTablePage': likely_table,
        'likelyMixedLayout': likely_mixed,
        'profileWarnings': warnings,
    }


# ------------------------------------------------------------------ #
# Document-level summary                                             #
# ------------------------------------------------------------------ #


def build_summary(page_profiles: list[dict[str, Any]]) -> dict[str, Any]:
    page_count = len(page_profiles)
    image_only = sum(1 for p in page_profiles if p['likelyImageOnly'])
    table_likely = sum(1 for p in page_profiles if p['likelyTablePage'])
    mixed_layout = sum(1 for p in page_profiles if p['likelyMixedLayout'])
    rotated = sum(1 for p in page_profiles if p['likelyRotated'])
    zero_content = sum(
        1 for p in page_profiles if p['embeddedTextCharacters'] == 0 and p['imageCount'] == 0
    )

    # Initial route estimates
    est_pdfplumber = sum(
        1 for p in page_profiles if p['hasEmbeddedTextLayer'] and not p['likelyImageOnly']
    )
    est_camelot = sum(
        1 for p in page_profiles if p['likelyTablePage'] and p['hasEmbeddedTextLayer']
    )
    est_docling = sum(1 for p in page_profiles if p['likelyMixedLayout'])
    est_paddleocr = sum(1 for p in page_profiles if p['likelyImageOnly'])
    est_llamaparse = 0  # never auto-estimate paid

    return {
        'pageCount': page_count,
        'imageOnlyPageCount': image_only,
        'tableLikelyPageCount': table_likely,
        'mixedLayoutPageCount': mixed_layout,
        'rotatedPageCount': rotated,
        'zeroContentPageCount': zero_content,
        'estimatedPdfplumberPages': est_pdfplumber,
        'estimatedCamelotPages': est_camelot,
        'estimatedDoclingPages': est_docling,
        'estimatedPaddleocrPages': est_paddleocr,
        'estimatedLlamaparsePages': est_llamaparse,
    }


# ------------------------------------------------------------------ #
# Full document profiling                                            #
# ------------------------------------------------------------------ #


def profile_document(
    source_path: str | Path,
    expected_sha256: str,
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Profile every page of a PDF document.

    Returns a document profile result dict matching DocumentProfileResultV1.
    Raises ValueError on source SHA mismatch.
    """
    thresh = thresholds or DEFAULT_THRESHOLDS

    # Verify source SHA before opening
    verify_source_sha256(source_path, expected_sha256)

    try:
        import pdfplumber
    except ImportError as e:
        raise RuntimeError('pdfplumber is required for profiling') from e

    page_profiles: list[dict[str, Any]] = []

    with pdfplumber.open(str(source_path)) as pdf:
        for page in pdf.pages:
            profile = profile_page(page, thresh)
            page_profiles.append(profile)

    summary = build_summary(page_profiles)
    config_sha = compute_profiling_config_sha256(thresh)

    result = {
        'schemaVersion': 'defense_budget_page_profile_v1',
        'sourceSha256': expected_sha256,
        'pages': page_profiles,
        'summary': summary,
        'profileConfigSha256': config_sha,
    }
    # Compute content SHA
    content_sha = sha256_canonical_json(result)
    result['contentSha256'] = content_sha

    return result


def profile_pages(
    source_path: str | Path,
    expected_sha256: str,
    requested_pages: list[int],
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Profile only the requested pages of a PDF document.

    Returns a document profile result dict (with only requested pages).
    Raises ValueError on source SHA mismatch.
    """
    thresh = thresholds or DEFAULT_THRESHOLDS

    # Verify source SHA before opening
    verify_source_sha256(source_path, expected_sha256)

    try:
        import pdfplumber
    except ImportError as e:
        raise RuntimeError('pdfplumber is required for profiling') from e

    page_profiles: list[dict[str, Any]] = []

    with pdfplumber.open(str(source_path)) as pdf:
        page_set = set(requested_pages)
        for page in pdf.pages:
            if page.page_number in page_set:
                profile = profile_page(page, thresh)
                page_profiles.append(profile)

    summary = build_summary(page_profiles)
    config_sha = compute_profiling_config_sha256(thresh)

    result = {
        'schemaVersion': 'defense_budget_page_profile_v1',
        'sourceSha256': expected_sha256,
        'pages': page_profiles,
        'summary': summary,
        'profileConfigSha256': config_sha,
    }
    content_sha = sha256_canonical_json(result)
    result['contentSha256'] = content_sha

    return result
