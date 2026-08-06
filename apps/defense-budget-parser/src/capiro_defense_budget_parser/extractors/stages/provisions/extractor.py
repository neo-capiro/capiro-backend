"""Deterministic, write-free HASC/SASC report-language extraction.

Consumes parser-runtime page results already proved for the same source documents as
money tables. It performs no network, AWS, database, OCR, or paid-parser calls.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from ....contracts import LayoutBlockV1, ParserPageResultV1
from .contracts import (
    AuthorizationProvisionEvidenceV1,
    AuthorizationProvisionExtractionResultV1,
    AuthorizationProvisionV1,
    BoundingBoxV1 as ProvisionBoundingBoxV1,
    ProvisionAuthorityV1,
    ProvisionCommitteeV1,
    ProvisionPageRangeV1,
    ProvisionStageV1,
)
from .semantics import (
    _caveat,
    _classify_action,
    _deadline,
    _extract_references,
    _normalize_text,
    _recipient,
    _scope,
)


@dataclass
class _DraftProvision:
    heading: str
    stage: ProvisionStageV1
    committee: ProvisionCommitteeV1
    authority: ProvisionAuthorityV1
    fiscal_year: int
    profile_id: str
    source_document_id: str
    source_sha256: str
    start_page: int
    printed_start: str | None
    end_page: int
    printed_end: str | None
    text_parts: list[str] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)


def extract_authorization_provisions(
    *,
    pages: list[ParserPageResultV1],
    stage: ProvisionStageV1,
    fiscal_year: int,
    profile_id: str,
    source_document_id: str,
    source_sha256: str,
    known_titles: list[str] | None = None,
) -> AuthorizationProvisionExtractionResultV1:
    """Extract deterministic report-language provisions from local parser pages."""
    if stage not in {'hasc', 'sasc'}:
        raise ValueError('stage must be hasc or sasc')
    committee: ProvisionCommitteeV1 = 'HASC' if stage == 'hasc' else 'SASC'
    authority: ProvisionAuthorityV1 = (
        'hasc_authorization' if stage == 'hasc' else 'sasc_authorization'
    )
    evidence: list[AuthorizationProvisionEvidenceV1] = []
    provisions: list[AuthorizationProvisionV1] = []
    warnings: list[str] = []
    omitted_pages: set[int] = set()
    draft: _DraftProvision | None = None
    normalized_titles = [title.strip() for title in (known_titles or []) if title.strip()]

    ordered_pages = sorted(pages, key=lambda item: item.page)
    for previous, current in zip(ordered_pages, ordered_pages[1:], strict=False):
        if current.page > previous.page + 1:
            omitted_pages.update(range(previous.page + 1, current.page))
            warnings.append(
                f'physical pages {previous.page + 1}-{current.page - 1}: missing from parser result'
            )

    for page in ordered_pages:
        blocks = sorted(
            page.blocks,
            key=lambda block: (
                block.readingOrder if block.readingOrder is not None else block.blockIndex,
                block.blockIndex,
            ),
        )
        usable = [
            block
            for block in blocks
            if (
                block.blockType in {'heading', 'paragraph', 'text', 'list_item'}
                and block.text.strip()
            )
        ]
        if not usable:
            omitted_pages.add(page.page)
            warnings.append(f'page {page.page}: no deterministic report-language blocks')
            continue

        for block in usable:
            text = block.text.strip()
            if block.blockType == 'heading':
                if draft is not None and draft.text_parts:
                    provisions.append(_finalize(draft, normalized_titles))
                draft = _DraftProvision(
                    heading=text,
                    stage=stage,
                    committee=committee,
                    authority=authority,
                    fiscal_year=fiscal_year,
                    profile_id=profile_id,
                    source_document_id=source_document_id,
                    source_sha256=source_sha256,
                    start_page=page.page,
                    printed_start=page.printedPage,
                    end_page=page.page,
                    printed_end=page.printedPage,
                )
                draft.evidence_ids.append(
                    _add_evidence(
                        evidence=evidence,
                        page=page,
                        block=block,
                        source_sha256=source_sha256,
                    )
                )
                continue

            if draft is None:
                warnings.append(
                    f'page {page.page} block {block.blockIndex}: '
                    'narrative before first heading omitted'
                )
                continue
            draft.text_parts.append(text)
            draft.end_page = page.page
            draft.printed_end = page.printedPage
            draft.evidence_ids.append(
                _add_evidence(
                    evidence=evidence,
                    page=page,
                    block=block,
                    source_sha256=source_sha256,
                )
            )

    if draft is not None and draft.text_parts:
        provisions.append(_finalize(draft, normalized_titles))

    return AuthorizationProvisionExtractionResultV1(
        stage=stage,
        profileId=profile_id,
        sourceDocumentId=source_document_id,
        sourceSha256=source_sha256,
        provisions=provisions,
        evidence=evidence,
        warnings=warnings,
        omittedPages=sorted(omitted_pages),
    )


def _finalize(draft: _DraftProvision, known_titles: list[str]) -> AuthorizationProvisionV1:
    full_text = '\n\n'.join(part.strip() for part in draft.text_parts if part.strip()).strip()
    haystack = f'{draft.heading}\n{full_text}'
    references = _extract_references(haystack, known_titles)
    scope = _scope(haystack, references)
    caveat = _caveat(scope)
    deadline = _deadline(full_text)
    recipient = _recipient(full_text)
    payload = {
        'stage': draft.stage,
        'sourceDocumentId': draft.source_document_id,
        'sourceSha256': draft.source_sha256,
        'fiscalYear': draft.fiscal_year,
        'heading': _normalize_text(draft.heading),
        'fullText': full_text,
        'startPage': draft.start_page,
        'endPage': draft.end_page,
    }
    provision_id = 'provision-' + hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()
    return AuthorizationProvisionV1(
        provisionId=provision_id,
        stage=draft.stage,
        committee=draft.committee,
        authority=draft.authority,
        fiscalYear=draft.fiscal_year,
        profileId=draft.profile_id,
        sourceDocumentId=draft.source_document_id,
        sourceSha256=draft.source_sha256,
        heading=draft.heading,
        fullText=full_text,
        pageRange=ProvisionPageRangeV1(
            startPage=draft.start_page,
            endPage=draft.end_page,
            printedStart=draft.printed_start,
            printedEnd=draft.printed_end,
        ),
        actionType=_classify_action(full_text),
        deadline=deadline,
        reportingRecipient=recipient,
        references=references,
        scope=scope,
        attributionCaveat=caveat,
        evidenceIds=list(dict.fromkeys(draft.evidence_ids)),
    )


def _add_evidence(
    *,
    evidence: list[AuthorizationProvisionEvidenceV1],
    page: ParserPageResultV1,
    block: LayoutBlockV1,
    source_sha256: str,
) -> str:
    payload = f'{source_sha256}|{page.page}|{block.blockIndex}|{block.text.strip()}'
    evidence_id = 'evidence-' + hashlib.sha256(payload.encode('utf-8')).hexdigest()
    evidence.append(
        AuthorizationProvisionEvidenceV1(
            evidenceId=evidence_id,
            sourceSha256=source_sha256,
            page=page.page,
            printedPage=page.printedPage,
            blockIndex=block.blockIndex,
            granularity='text_span' if block.boundingBox is not None else 'page_only',
            excerpt=block.text.strip(),
            boundingBox=(
                ProvisionBoundingBoxV1(
                    x0=block.boundingBox.x0,
                    y0=block.boundingBox.y0,
                    x1=block.boundingBox.x1,
                    y1=block.boundingBox.y1,
                )
                if block.boundingBox is not None
                else None
            ),
        )
    )
    return evidence_id


