"""Strict cross-language contract for Phase 6 authorization-report provisions."""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_SHA256_RE = re.compile(r'^[a-f0-9]{64}$')
_PE_RE = re.compile(r'^[0-9]{7}[A-Z]$')
_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

ProvisionStageV1 = Literal['hasc', 'sasc']
ProvisionCommitteeV1 = Literal['HASC', 'SASC']
ProvisionAuthorityV1 = Literal['hasc_authorization', 'sasc_authorization']
ProvisionActionTypeV1 = Literal[
    'directs_briefing',
    'directs_report',
    'adds',
    'cuts',
    'transfers',
    'restricts',
    'encourages',
    'expresses_concern',
    'narrative',
]
ProvisionScopeV1 = Literal[
    'line_specific',
    'project_specific',
    'program_wide',
    'account_wide',
    'component_wide',
    'department_wide',
]
BudgetComponentV1 = Literal[
    'ARMY',
    'NAVY',
    'AF',
    'SF',
    'USMC',
    'DW',
    'DARPA',
    'DHA',
    'MDA',
    'SOCOM',
    'OTHER',
    'UNKNOWN',
]


class BoundingBoxV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    x0: str
    y0: str
    x1: str
    y1: str


class ProvisionPageRangeV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    startPage: int = Field(ge=1)
    endPage: int = Field(ge=1)
    printedStart: str | None = None
    printedEnd: str | None = None

    @model_validator(mode='after')
    def validate_order(self) -> ProvisionPageRangeV1:
        if self.endPage < self.startPage:
            raise ValueError('endPage must be >= startPage')
        return self


class ExplicitDateDeadlineV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    kind: Literal['date'] = 'date'
    rawText: str = Field(min_length=1)
    isoDate: str

    @field_validator('isoDate')
    @classmethod
    def validate_date(cls, value: str) -> str:
        if _DATE_RE.fullmatch(value) is None:
            raise ValueError('expected YYYY-MM-DD')
        return value


class RelativeDeadlineV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    kind: Literal['relative'] = 'relative'
    rawText: str = Field(min_length=1)
    days: int | None = Field(default=None, gt=0)


ProvisionDeadlineV1 = Annotated[
    ExplicitDateDeadlineV1 | RelativeDeadlineV1,
    Field(discriminator='kind'),
]


class ReportingRecipientV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    rawText: str = Field(min_length=1)
    normalized: str | None = None


class PeCodeReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['pe_code'] = 'pe_code'
    peCode: str
    title: str | None = None

    @field_validator('peCode')
    @classmethod
    def validate_pe(cls, value: str) -> str:
        normalized = value.upper()
        if _PE_RE.fullmatch(normalized) is None:
            raise ValueError('invalid PE code')
        return normalized


class RdteProjectReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['rdte_project'] = 'rdte_project'
    peCode: str
    projectCode: str = Field(min_length=1)
    title: str | None = None

    @field_validator('peCode')
    @classmethod
    def validate_pe(cls, value: str) -> str:
        normalized = value.upper()
        if _PE_RE.fullmatch(normalized) is None:
            raise ValueError('invalid PE code')
        return normalized


class ProcurementReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['procurement_line'] = 'procurement_line'
    code: str = Field(min_length=1)
    account: str = Field(min_length=1)
    component: BudgetComponentV1
    advanceProcurement: bool | None = None
    title: str | None = None


class OmSagReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['om_sag'] = 'om_sag'
    code: str = Field(min_length=1)
    account: str = Field(min_length=1)
    component: BudgetComponentV1
    title: str | None = None


class MilconProjectReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['milcon_project'] = 'milcon_project'
    projectCode: str = Field(min_length=1)
    component: BudgetComponentV1
    location: str | None = None
    title: str | None = None


class TitleOnlyReferenceV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    referenceKind: Literal['title_only'] = 'title_only'
    title: str = Field(min_length=1)


ProvisionReferenceV1 = Annotated[
    PeCodeReferenceV1
    | RdteProjectReferenceV1
    | ProcurementReferenceV1
    | OmSagReferenceV1
    | MilconProjectReferenceV1
    | TitleOnlyReferenceV1,
    Field(discriminator='referenceKind'),
]


class AuthorizationProvisionV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal['authorization_provision_v1'] = 'authorization_provision_v1'
    provisionId: str = Field(min_length=1)
    track: Literal['authorization'] = 'authorization'
    stage: ProvisionStageV1
    committee: ProvisionCommitteeV1
    authority: ProvisionAuthorityV1
    fiscalYear: int = Field(ge=1900, le=2200)
    profileId: str = Field(min_length=1)
    sourceDocumentId: str = Field(min_length=1)
    sourceSha256: str
    heading: str = Field(min_length=1)
    fullText: str = Field(min_length=1)
    pageRange: ProvisionPageRangeV1
    actionType: ProvisionActionTypeV1
    deadline: ProvisionDeadlineV1 | None = None
    reportingRecipient: ReportingRecipientV1 | None = None
    references: list[ProvisionReferenceV1]
    scope: ProvisionScopeV1
    attributionCaveat: str | None = None
    evidenceIds: list[str] = Field(min_length=1)

    @field_validator('sourceSha256')
    @classmethod
    def validate_sha(cls, value: str) -> str:
        if _SHA256_RE.fullmatch(value) is None:
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return value

    @model_validator(mode='after')
    def validate_committee_and_scope(self) -> AuthorizationProvisionV1:
        expected = (
            ('HASC', 'hasc_authorization')
            if self.stage == 'hasc'
            else ('SASC', 'sasc_authorization')
        )
        if (self.committee, self.authority) != expected:
            raise ValueError('stage, committee, and authority must agree')
        if self.scope not in {'line_specific', 'project_specific'} and not self.attributionCaveat:
            raise ValueError('non-line-specific provision requires attributionCaveat')
        if len(set(self.evidenceIds)) != len(self.evidenceIds):
            raise ValueError('evidenceIds must be unique')
        return self


class AuthorizationProvisionEvidenceV1(BaseModel):
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
    def validate_sha(cls, value: str) -> str:
        if _SHA256_RE.fullmatch(value) is None:
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return value


class AuthorizationProvisionExtractionResultV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal[
        'authorization_provision_extraction_result_v1'
    ] = 'authorization_provision_extraction_result_v1'
    stage: ProvisionStageV1
    profileId: str = Field(min_length=1)
    sourceDocumentId: str = Field(min_length=1)
    sourceSha256: str
    provisions: list[AuthorizationProvisionV1]
    evidence: list[AuthorizationProvisionEvidenceV1]
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
    def validate_omitted_pages(cls, value: list[int]) -> list[int]:
        if value != sorted(set(value)) or any(page < 1 for page in value):
            raise ValueError('omittedPages must be sorted unique positive pages')
        return value
