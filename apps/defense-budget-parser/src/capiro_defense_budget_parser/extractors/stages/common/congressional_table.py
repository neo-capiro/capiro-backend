"""Strict normalized congressional-table contract shared by Phase 6 stages.

The JSON shape intentionally uses the TypeScript contract's camelCase fields.
Money remains canonical decimal strings. Header meaning is explicit and no
consumer is permitted to recover semantics from column position.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_CANONICAL_DECIMAL_RE = re.compile(r'^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$')

MoneyUnitV1 = Literal['dollars', 'thousands', 'millions']
MoneySemanticV1 = Literal[
    'request_baseline',
    'change',
    'recommended_total',
    'authorized_total',
    'appropriated_total',
    'enacted_total',
    'transfer_amount',
    'rescission_amount',
]
RowSemanticKindV1 = Literal[
    'absolute_position',
    'adjustment',
    'transfer_in',
    'transfer_out',
    'rescission',
    'quantity_change',
    'undistributed',
   'general_provision',
   'narrative_only',
   'unresolved',
]


class BoundingBoxV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    x0: str
    y0: str
    x1: str
    y1: str


class TextSpanV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    start: int = Field(ge=0)
    end: int = Field(ge=0)

    @model_validator(mode='after')
    def validate_order(self) -> TextSpanV1:
        if self.start >= self.end:
            raise ValueError('text span requires start < end')
        return self


class CongressionalColumnV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    columnIndex: int = Field(ge=0)
    headerText: str = Field(min_length=1)
    moneySemantic: MoneySemanticV1 | None = None
    fiscalYear: int | None = Field(default=None, ge=1900, le=2200)
    declaredUnit: MoneyUnitV1 | None = None
    isQuantity: bool


class CongressionalCellV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    rowIndex: int = Field(ge=0)
    columnIndex: int = Field(ge=0)
    rawText: str
    value: str | None = None
    boundingBox: BoundingBoxV1 | None = None
    textSpan: TextSpanV1 | None = None

    @field_validator('value')
    @classmethod
    def validate_canonical_decimal(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not _CANONICAL_DECIMAL_RE.fullmatch(value) or value == '-0':
            raise ValueError('expected canonical decimal string')
        if '.' in value and value.endswith('0'):
            raise ValueError('expected canonical decimal string')
        return value


class PeCodeReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['pe_code'] = 'pe_code'
    peCode: str = Field(min_length=1)
    rowTitle: str | None = None


class ProcurementReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['procurement_line'] = 'procurement_line'
    lineCode: str = Field(min_length=1)
    account: str | None = None
    component: str | None = None
    advanceProcurement: bool | None = None
    rowTitle: str | None = None


class OmSagReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['om_sag'] = 'om_sag'
    sagCode: str = Field(min_length=1)
    account: str | None = None
    component: str | None = None
    rowTitle: str | None = None


class MilconReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['milcon_project'] = 'milcon_project'
    projectCode: str = Field(min_length=1)
    component: str | None = None
    location: str | None = None
    rowTitle: str | None = None


class PackageScopeReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['package_scope'] = 'package_scope'
    scope: str = Field(min_length=1)
    rowTitle: str | None = None


class UnresolvedReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['unresolved_reference'] = 'unresolved_reference'
    rawText: str = Field(min_length=1)


BudgetLineReferenceV1 = (
    PeCodeReferenceV1
    | ProcurementReferenceV1
    | OmSagReferenceV1
    | MilconReferenceV1
    | PackageScopeReferenceV1
    | UnresolvedReferenceV1
)


class CongressionalRowV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    rowIndex: int = Field(ge=0)
    rawLabel: str
    reference: BudgetLineReferenceV1 = Field(discriminator='referenceKind')
    semanticKind: RowSemanticKindV1
    cells: list[CongressionalCellV1]
    finding: str | None = None


class CongressionalTableV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal['congressional_table_v1'] = 'congressional_table_v1'
    profileId: str = Field(min_length=1)
    sourceDocumentId: str = Field(min_length=1)
    sourceSha256: str = Field(min_length=1)
    page: int = Field(ge=1)
    printedPage: str | None = None
    headings: list[str]
    declaredUnit: MoneyUnitV1 | None = None
    columns: list[CongressionalColumnV1]
    rows: list[CongressionalRowV1]


class StageExtractionResultV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal['stage_extraction_result_v1'] = 'stage_extraction_result_v1'
    stage: Literal['hasc', 'sasc', 'ndaa_conference', 'hac_d', 'sac_d', 'appropriations_conference']
    profileId: str = Field(min_length=1)
    sourceDocumentId: str = Field(min_length=1)
    sourceSha256: str = Field(min_length=1)
    tables: list[CongressionalTableV1]
    warnings: list[str]
    omittedPages: list[int]
