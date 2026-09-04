"""Lightweight persisted parser-version vocabulary.

This module imports no parser or ML runtime. `importlib.metadata` reads installed
package metadata so the lightweight version command and the engine module use
one exact Docling identity without loading Torch or model code.
"""

from importlib.metadata import PackageNotFoundError, version

PDFPLUMBER_ENGINE_VERSION = 'pdfplumber-0.11.0'
CAMELOT_ENGINE_VERSION = 'camelot-0.11.0'
PADDLEOCR_ENGINE_VERSION = 'paddleocr-det-rec-row-reconstruction-v1'

# Phase 10B-21A: same typed sentinel `docling_engine.py` uses for "genuinely
# not installed". Duplicated as a literal (not imported) deliberately -- this
# module's own contract is that it imports no parser/ML runtime, and
# `docling_engine` cannot be imported here without violating that.
ENGINE_UNAVAILABLE = 'ENGINE_UNAVAILABLE'


def _optional_engine_version(package_name: str, prefix: str) -> str:
    """A version string when installed, or the typed unavailable sentinel.

    Never a version-shaped fallback string ("{prefix}-unavailable-cpu"):
    those are truthy and pass a plain `if (!parserVersion)` check on the
    TypeScript side, which is exactly how a specialized image that
    deliberately omits this optional dependency got dispatched to an engine
    that cannot run (Phase 10B-20 finding).
    """
    try:
        return f'{prefix}-{version(package_name)}-cpu'
    except PackageNotFoundError:
        return ENGINE_UNAVAILABLE


DOCLING_ENGINE_VERSION = _optional_engine_version('docling', 'docling')

ENGINE_VERSIONS: dict[str, str] = {
    'deterministic_pdfplumber': PDFPLUMBER_ENGINE_VERSION,
    'camelot': CAMELOT_ENGINE_VERSION,
    'docling': DOCLING_ENGINE_VERSION,
    'paddleocr': PADDLEOCR_ENGINE_VERSION,
}
