"""capiro_defense_budget_parser.contracts — cross-language parser contract.

Mirrors apps/api/src/defense-budget/parser-router/parser-runtime-contract-v1.ts exactly.
All page numbers are 1-based physical PDF page numbers.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ------------------------------------------------------------------ #
# A1. Schema version constants                                       #
# ------------------------------------------------------------------ #

DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION: Final = 'defense_budget_parser_job_v1'
DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION: Final = 'defense_budget_parser_result_v1'
DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION: Final = 'defense_budget_parse_plan_v1'

# ------------------------------------------------------------------ #
# A2. Parser runtime engine vocabulary                               #
# ------------------------------------------------------------------ #

ParserRuntimeEngineV1 = Literal[
    'deterministic_pdfplumber',
    'camelot',
    'docling',
    'paddleocr',
]

ExtractionMethodV1 = Literal[
    'native_structured',
    'deterministic_pdfplumber',
    'camelot',
    'docling',
    'paddleocr',
    'llamaparse',
    'manual',
]

# ------------------------------------------------------------------ #
# A3. Evidence precision vocabulary                                   #
# ------------------------------------------------------------------ #

EvidencePrecisionV1 = Literal['page_only', 'text_span', 'cell_bbox']

# ------------------------------------------------------------------ #
# A4. Bounding box                                                    #
# ------------------------------------------------------------------ #


class BoundingBoxV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    x0: str
    y0: str
    x1: str
    y1: str


# ------------------------------------------------------------------ #
# A5. Layout block contract                                          #
# ------------------------------------------------------------------ #

BlockTypeV1 = Literal[
    'text',
    'heading',
    'paragraph',
    'list_item',
    'table',
    'image',
    'header',
    'footer',
    'caption',
    'unknown',
]


class LayoutBlockV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    blockIndex: int = Field(ge=0)
    blockType: BlockTypeV1
    text: str
    readingOrder: int | None = Field(default=None, ge=0)
    boundingBox: BoundingBoxV1 | None = None


# ------------------------------------------------------------------ #
# A6. Parsed table cell                                               #
# ------------------------------------------------------------------ #


class ParsedTableCellV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    rowIndex: int = Field(ge=0)
    columnIndex: int = Field(ge=0)
    text: str
    rowSpan: int | None = Field(default=None, ge=1)
    colSpan: int | None = Field(default=None, ge=1)
    boundingBox: BoundingBoxV1 | None = None
    confidence: str | None = None


# ------------------------------------------------------------------ #
# A7. Parsed table                                                    #
# ------------------------------------------------------------------ #


class ParsedTableV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    tableIndex: int = Field(ge=0)
    label: str | None = None
    rowCount: int = Field(ge=0)
    columnCount: int = Field(ge=0)
    cells: list[ParsedTableCellV1]
    boundingBox: BoundingBoxV1 | None = None
    parserReportAccuracy: str | None = None
    warnings: list[str]


# ------------------------------------------------------------------ #
# A8. Parsed image region                                            #
# ------------------------------------------------------------------ #


class ParsedImageRegionV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    imageIndex: int = Field(ge=0)
    boundingBox: BoundingBoxV1 | None = None
    width: str | None = None
    height: str | None = None
    format: str | None = None


# ------------------------------------------------------------------ #
# A9. Page result                                                    #
# ------------------------------------------------------------------ #


class ParserPageResultV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page: int = Field(ge=1)
    width: str | None = None
    height: str | None = None
    rotation: int | None = None
    text: str | None = None
    markdown: str | None = None
    printedPage: str | None = None
    blocks: list[LayoutBlockV1]
    tables: list[ParsedTableV1]
    images: list[ParsedImageRegionV1]
    confidence: str | None = None
    evidencePrecision: EvidencePrecisionV1
    warnings: list[str]


# ------------------------------------------------------------------ #
# A10. Page failure                                                  #
# ------------------------------------------------------------------ #

ParserPageFailureCodeV1 = Literal[
    'no_embedded_text',
    'page_out_of_range',
    'pdf_parse_error',
    'no_table_detected',
    'table_shape_unstable',
    'coordinate_error',
    'render_error',
    'model_unavailable',
    'timeout',
    'unknown_error',
]


class ParserPageFailureV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page: int = Field(ge=1)
    code: ParserPageFailureCodeV1
    message: str


# ------------------------------------------------------------------ #
# A11. Runtime warning                                               #
# ------------------------------------------------------------------ #


class ParserRuntimeWarningV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    code: str = Field(min_length=1)
    message: str
    pages: list[int] = Field(ge=1)  # non-empty list of positive ints


# ------------------------------------------------------------------ #
# A12. Runtime metrics                                               #
# ------------------------------------------------------------------ #


class ParserRuntimeMetricsV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    durationMillis: int = Field(ge=0)
    pagesProcessed: int = Field(ge=0)
    pagesSucceeded: int = Field(ge=0)
    pagesFailed: int = Field(ge=0)
    engineVersion: str = Field(min_length=1)
    modelVersions: list[str] | None = None


# ------------------------------------------------------------------ #
# A13. Job contract                                                   #
# ------------------------------------------------------------------ #


def _validate_sorted_unique_positive_pages(pages: list[int]) -> list[int]:
    if not pages:
        raise ValueError('pages must be nonempty')
    for p in pages:
        if p < 1:
            raise ValueError('pages must be positive')
    sorted_pages = sorted(pages)
    if pages != sorted_pages:
        raise ValueError('pages must be sorted ascending')
    if len(set(pages)) != len(pages):
        raise ValueError('pages must be unique')
    return pages


class ParserRuntimeJobV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal['defense_budget_parser_job_v1'] = Field(
        default=DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION
    )
    jobId: str = Field(min_length=1)
    sourcePath: str = Field(min_length=1)
    sourceSha256: str
    engine: ParserRuntimeEngineV1
    requestedPages: list[int]
    parserVersion: str = Field(min_length=1)
    parserConfig: Any  # JSON value
    parserConfigSha256: str
    outputDirectory: str = Field(min_length=1)
    includeDebugArtifacts: bool

    @field_validator('sourceSha256', 'parserConfigSha256')
    @classmethod
    def _validate_sha256(cls, v: str) -> str:
        if not (isinstance(v, str) and len(v) == 64 and all(c in '0123456789abcdef' for c in v)):
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return v

    @field_validator('requestedPages')
    @classmethod
    def _validate_pages(cls, v: list[int]) -> list[int]:
        return _validate_sorted_unique_positive_pages(v)


# ------------------------------------------------------------------ #
# A14. Result contract                                               #
# ------------------------------------------------------------------ #


class ParserRuntimeResultV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal['defense_budget_parser_result_v1'] = Field(
        default=DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION
    )
    jobId: str = Field(min_length=1)
    engine: ExtractionMethodV1
    parserVersion: str = Field(min_length=1)
    parserConfigSha256: str
    inputSourceSha256: str
    requestedPages: list[int]
    succeededPages: list[int]
    failedPages: list[ParserPageFailureV1]
    pages: list[ParserPageResultV1]
    warnings: list[ParserRuntimeWarningV1]
    metrics: ParserRuntimeMetricsV1
    contentSha256: str

    @field_validator('parserConfigSha256', 'inputSourceSha256', 'contentSha256')
    @classmethod
    def _validate_sha256(cls, v: str) -> str:
        if not (isinstance(v, str) and len(v) == 64 and all(c in '0123456789abcdef' for c in v)):
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return v

    @field_validator('requestedPages')
    @classmethod
    def _validate_pages(cls, v: list[int]) -> list[int]:
        return _validate_sorted_unique_positive_pages(v)


# ------------------------------------------------------------------ #
# A15. Document execution state machine                              #
# ------------------------------------------------------------------ #

ParserDocumentStateV1 = Literal[
    'PLANNED',
    'RUNNING_LOCAL',
    'LOCAL_COMPLETE',
    'VERIFYING',
    'ESCALATION_PLANNED',
    'RUNNING_PAID',
    'PAID_COMPLETE',
    'TERMINAL_PASSED',
    'TERMINAL_REVIEW',
    'TERMINAL_REJECTED',
    'FAILED',
]

PARSER_STATE_TRANSITIONS: dict[str, tuple[str, ...]] = {
    'PLANNED': ('RUNNING_LOCAL', 'FAILED'),
    'RUNNING_LOCAL': ('LOCAL_COMPLETE', 'FAILED'),
    'LOCAL_COMPLETE': ('VERIFYING', 'FAILED'),
    'VERIFYING': (
        'ESCALATION_PLANNED',
        'TERMINAL_PASSED',
        'TERMINAL_REVIEW',
        'TERMINAL_REJECTED',
        'FAILED',
    ),
    'ESCALATION_PLANNED': (
        'RUNNING_PAID',
        'TERMINAL_REVIEW',
        'TERMINAL_REJECTED',
        'FAILED',
    ),
    'RUNNING_PAID': ('PAID_COMPLETE', 'FAILED'),
    'PAID_COMPLETE': ('VERIFYING', 'FAILED'),
    'TERMINAL_PASSED': (),
    'TERMINAL_REVIEW': (),
    'TERMINAL_REJECTED': (),
    'FAILED': (),
}

_TERMINAL_STATES: frozenset[str] = frozenset(
    {'TERMINAL_PASSED', 'TERMINAL_REVIEW', 'TERMINAL_REJECTED', 'FAILED'}
)


def is_terminal_state(state: str) -> bool:
    return state in _TERMINAL_STATES


def is_valid_transition(from_state: str, to_state: str) -> bool:
    if is_terminal_state(from_state):
        return False
    return to_state in PARSER_STATE_TRANSITIONS.get(from_state, ())


# ------------------------------------------------------------------ #
# A16. Canonical JSON and hashing helpers                            #
# ------------------------------------------------------------------ #


def canonical_json_stringify(value: Any) -> str:
    """Serialize to canonical JSON: sorted keys, no extra whitespace."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha256_hex(input_str: str) -> str:
    return hashlib.sha256(input_str.encode('utf-8')).hexdigest()


def sha256_canonical_json(value: Any) -> str:
    return sha256_hex(canonical_json_stringify(value))


# ------------------------------------------------------------------ #
# A17. Parser-run identity and cache key                             #
# ------------------------------------------------------------------ #


def compute_parser_run_cache_key(
    source_sha256: str,
    method: str,
    parser_version: str,
    parser_config_sha256: str,
    pages: list[int],
    runtime_contract_version: str,
) -> str:
    canonical = {
        'sourceSha256': source_sha256,
        'method': method,
        'parserVersion': parser_version,
        'parserConfigSha256': parser_config_sha256,
        'pages': sorted(pages),
        'runtimeContractVersion': runtime_contract_version,
    }
    return sha256_canonical_json(canonical)


def compute_parser_run_id(
    source_sha256: str,
    method: str,
    parser_version: str,
    parser_config_sha256: str,
    pages: list[int],
) -> str:
    canonical = {
        'sourceSha256': source_sha256,
        'method': method,
        'parserVersion': parser_version,
        'parserConfigSha256': parser_config_sha256,
        'pages': sorted(pages),
    }
    return f'pr1_{sha256_canonical_json(canonical)}'


def compute_parser_config_sha256(config: Any) -> str:
    return sha256_canonical_json(config)


def compute_result_content_sha256(result_dict: dict[str, Any]) -> str:
    """Compute content SHA from a result dict, excluding the contentSha256 field."""
    rest = {k: v for k, v in result_dict.items() if k != 'contentSha256'}
    return sha256_canonical_json(rest)


# ------------------------------------------------------------------ #
# A18. Page range key                                                #
# ------------------------------------------------------------------ #


def page_range_key(pages: list[int]) -> str:
    if not pages:
        return 'none'
    sorted_pages = sorted(pages)
    parts: list[str] = []
    start = sorted_pages[0]
    end = sorted_pages[0]
    for p in sorted_pages[1:]:
        if p == end + 1:
            end = p
        else:
            parts.append(f'{start}' if start == end else f'{start}-{end}')
            start = p
            end = p
    parts.append(f'{start}' if start == end else f'{start}-{end}')
    return ','.join(parts)
