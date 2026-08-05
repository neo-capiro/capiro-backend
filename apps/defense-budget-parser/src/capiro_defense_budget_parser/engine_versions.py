"""Lightweight persisted parser-version vocabulary.

This module imports no parser or ML runtime. `importlib.metadata` reads installed
package metadata so the lightweight version command and the engine module use
one exact Docling identity without loading Torch or model code.
"""

from importlib.metadata import PackageNotFoundError, version

PDFPLUMBER_ENGINE_VERSION = 'pdfplumber-0.11.0'
CAMELOT_ENGINE_VERSION = 'camelot-0.11.0'
PADDLEOCR_ENGINE_VERSION = 'paddleocr-pp-structure-v3-cpu'

try:
    _docling_package_version = version('docling')
except PackageNotFoundError:
    _docling_package_version = 'unavailable'
DOCLING_ENGINE_VERSION = f'docling-{_docling_package_version}-cpu'

ENGINE_VERSIONS: dict[str, str] = {
    'deterministic_pdfplumber': PDFPLUMBER_ENGINE_VERSION,
    'camelot': CAMELOT_ENGINE_VERSION,
    'docling': DOCLING_ENGINE_VERSION,
    'paddleocr': PADDLEOCR_ENGINE_VERSION,
}
