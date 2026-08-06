"""Strict NDAA conference table, vehicle-adjacent language, and disposition contracts."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..common.congressional_table import CongressionalTableV1
from ..provisions.contracts import (
    BoundingBoxV1,
    ProvisionActionTypeV1,
    ProvisionDeadlineV1,
    ProvisionReferenceV1,
    ProvisionScopeV1,
    ReportingRecipientV1,
)

_SHA256_RE = re.compile(r'^[a-f0-9]{64}$')

ConferenceColumnRoleV1 = Literal[
    'label',
    'request_baseline',
    'hasc',
    'sasc',
    'ndaa_conference',
    'change',
    'quantity',
    'other',
]


class NdaaConferenceColumnRoleV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    columnIndex: int = Field(ge=0)
    role: ConferenceColumnRoleV1


class NdaaConferenceTableV1(BaseModel):
    """Workstream-C table plus explicit printed chamber/conference column roles."""

    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal['ndaa_conference_table_v1'] = 'ndaa_conference_table_v1'
    table: CongressionalTableV1
    columnRoles: list[NdaaConferenceColumnRoleV1]

    @model_validator(mode='after')
    def validate_roles(self) -> NdaaConferenceTableV1:
        indices = [value.columnIndex for value in self.columnRoles]
        if len(indices) != len(set(indices)):
            raise ValueError('columnRoles must contain unique columnIndex values')
        table_indices = {column.columnIndex for column in self.table.columns}
        if any(index not in table_indices for index in indices):
            raise ValueError('columnRoles must reference table columns')
        role_map = {value.columnIndex: value.role for value in self.columnRoles}
        for column in self.table.columns:
            role = role_map.get(column.columnIndex)
            if role == 'quantity' and not column.isQuantity:
                raise ValueError('quantity role requires isQuantity=true')
            if role in {'hasc', 'sasc', 'ndaa_conference', 'request_baseline', 'change'}:
                if column.moneySemantic is None:
                    raise ValueError(f'{role} role requires a moneySemantic')
        return self


class NdaaConferenceExtractionResultV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal[
        'ndaa_conference_extraction_result_v1'
    ] = 'ndaa_conference_extraction_result_v1'
    stage: Literal['ndaa_conference'] = 'ndaa_conference'
    profileId: str = Field(min_length=1)
    sourceDocumentId: str = Field(min_length=1)
    sourceSha256: str
    tables: list[NdaaConferenceTableV1]
    warnings: list[str]
    omittedPages: list[int]

    @field_validator('sourceSha256')
    @classmethod
    def validate_sha(cls, value: str) -> str:
        if _SHA256_RE.fullmatch(value) is None:
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return value

    @field_validator('omittedPages')
    @classmethod
    def validate_pages(cls, value: list[int]) -> list[int]:
        if value != sorted(set(value)) or any(page < 1 for page in value):
            raise ValueError('omittedPages must be sorted unique positive pages')
        return value


ConferenceDispositionChamberV1 = Literal['house', 'senate', 'both']
ConferenceDispositionTypeV1 = Literal[
    'adopted',
    'modified',
    'not_adopted',
    'receded',
    'agreed',
]


class NdaaConferenceChamberDispositionV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    chamber: ConferenceDispositionChamberV1
    disposition: ConferenceDispositionTypeV1
    rawText: str = Field(min_length=1)


class NdaaConferenceLanguageEvidenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    evidenceId: str = Field(min_length=1)
    sourceSha256: str
    page: int = Field(ge=1)
    printedPage: str | None = None
    blockIndex: int = Field(ge=0)
    granularity: Literal['page_only', 'text_span']
    excerpt: str = Field(min_length=1)
    boundingBox: BoundingBoxV1 | None = None

    @field_validator('sourceSha256')
    @classmethod
    def validate_evidence_sha(cls, value: str) -> str:
        if _SHA256_RE.fullmatch(value) is None:
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return value


class NdaaConferenceLanguageProvisionV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal['ndaa_conference_language_v1'] = 'ndaa_conference_language_v1'
    provisionId: str = Field(min_length=1)
    track: Literal['authorization'] = 'authorization'
    stage: Literal['ndaa_conference'] = 'ndaa_conference'
    authority: Literal['ndaa_conference_authorization'] = 'ndaa_conference_authorization'
    fiscalYear: int = Field(ge=1900, le=2200)
    profileId: str = Field(min_length=1)
    sourceDocumentId: str = Field(min_length=1)
    sourceSha256: str
    heading: str = Field(min_length=1)
    fullText: str = Field(min_length=1)
    startPage: int = Field(ge=1)
    endPage: int = Field(ge=1)
    printedStart: str | None = None
    printedEnd: str | None = None
    actionType: ProvisionActionTypeV1
    deadline: ProvisionDeadlineV1 | None = None
    reportingRecipient: ReportingRecipientV1 | None = None
    references: list[ProvisionReferenceV1]
    scope: ProvisionScopeV1
    attributionCaveat: str | None = None
    chamberDispositions: list[NdaaConferenceChamberDispositionV1]
    evidenceIds: list[str] = Field(min_length=1)

    @field_validator('sourceSha256')
    @classmethod
    def validate_language_sha(cls, value: str) -> str:
        if _SHA256_RE.fullmatch(value) is None:
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return value

    @model_validator(mode='after')
    def validate_language(self) -> NdaaConferenceLanguageProvisionV1:
        if self.endPage < self.startPage:
            raise ValueError('endPage must be >= startPage')
        if self.scope not in {'line_specific', 'project_specific'} and not self.attributionCaveat:
            raise ValueError('non-line-specific provision requires attributionCaveat')
        if len(set(self.evidenceIds)) != len(self.evidenceIds):
            raise ValueError('evidenceIds must be unique')
        return self


class NdaaConferenceLanguageExtractionResultV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal[
        'ndaa_conference_language_extraction_result_v1'
    ] = 'ndaa_conference_language_extraction_result_v1'
    stage: Literal['ndaa_conference'] = 'ndaa_conference'
    profileId: str = Field(min_length=1)
    sourceDocumentId: str = Field(min_length=1)
    sourceSha256: str
    provisions: list[NdaaConferenceLanguageProvisionV1]
    evidence: list[NdaaConferenceLanguageEvidenceV1]
    warnings: list[str]
    omittedPages: list[int]

    @field_validator('sourceSha256')
    @classmethod
    def validate_result_sha(cls, value: str) -> str:
        if _SHA256_RE.fullmatch(value) is None:
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return value
