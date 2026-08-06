"""Strict all-pages/page-subset profiling job contract."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DEFENSE_BUDGET_PROFILE_JOB_SCHEMA_VERSION: Literal['defense_budget_profile_job_v1'] = (
    'defense_budget_profile_job_v1'
)


class ParserProfileJobV1(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schemaVersion: Literal['defense_budget_profile_job_v1'] = Field(
        default=DEFENSE_BUDGET_PROFILE_JOB_SCHEMA_VERSION
    )
    jobId: str = Field(min_length=1)
    sourcePath: str = Field(min_length=1)
    sourceSha256: str
    engine: Literal['deterministic_pdfplumber']
    allPages: bool
    requestedPages: list[int]
    parserVersion: str = Field(min_length=1)
    parserConfig: Any
    parserConfigSha256: str
    outputDirectory: str = Field(min_length=1)
    includeDebugArtifacts: bool

    @field_validator('sourceSha256', 'parserConfigSha256')
    @classmethod
    def _validate_sha256(cls, value: str) -> str:
        if not (
            isinstance(value, str)
            and len(value) == 64
            and all(character in '0123456789abcdef' for character in value)
        ):
            raise ValueError('expected lowercase 64-character hexadecimal SHA-256')
        return value

    @field_validator('requestedPages')
    @classmethod
    def _validate_pages(cls, pages: list[int]) -> list[int]:
        if any(page < 1 for page in pages):
            raise ValueError('requestedPages must be positive')
        if pages != sorted(pages) or len(set(pages)) != len(pages):
            raise ValueError('requestedPages must be sorted and unique')
        return pages

    @model_validator(mode='after')
    def _validate_scope(self) -> ParserProfileJobV1:
        if self.allPages and self.requestedPages:
            raise ValueError('allPages=true requires empty requestedPages')
        if not self.allPages and not self.requestedPages:
            raise ValueError('allPages=false requires requestedPages')
        return self
