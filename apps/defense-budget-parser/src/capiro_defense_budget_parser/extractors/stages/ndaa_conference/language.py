"""Deterministic NDAA conference report-language and chamber-disposition extraction."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from ....contracts import LayoutBlockV1, ParserPageResultV1
from ..provisions.semantics import (
    _caveat,
    _classify_action,
    _deadline,
    _extract_references,
    _normalize_text,
    _recipient,
    _scope,
)
from .contracts import (
    NdaaConferenceLanguageEvidenceV1,
    NdaaConferenceLanguageExtractionResultV1,
    NdaaConferenceLanguageProvisionV1,
)
from .semantics import chamber_dispositions


@dataclass
class _Draft:
    heading: str
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


def extract_ndaa_conference_language(
    *,
    pages: list[ParserPageResultV1],
    fiscal_year: int,
    profile_id: str,
    source_document_id: str,
    source_sha256: str,
    known_titles: list[str] | None = None,
) -> NdaaConferenceLanguageExtractionResultV1:
    evidence: list[NdaaConferenceLanguageEvidenceV1] = []
    provisions: list[NdaaConferenceLanguageProvisionV1] = []
    warnings: list[str] = []
    omitted_pages: set[int] = set()
    draft: _Draft | None = None
    titles = [title.strip() for title in (known_titles or []) if title.strip()]
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
            if block.blockType in {'heading', 'paragraph', 'text', 'list_item'} and block.text.strip()
        ]
        if not usable:
            omitted_pages.add(page.page)
            warnings.append(f'page {page.page}: no deterministic conference-language blocks')
            continue

        for block in usable:
            text = block.text.strip()
            if block.blockType == 'heading':
                if draft is not None and draft.text_parts:
                    provisions.append(_finalize(draft, titles))
                draft = _Draft(
                    heading=text,
                    fiscal_year=fiscal_year,
                    profile_id=profile_id,
                    source_document_id=source_document_id,
                    source_sha256=source_sha256,
                    start_page=page.page,
                    printed_start=page.printedPage,
                    end_page=page.page,
                    printed_end=page.printedPage,
                )
                draft.evidence_ids.append(_add_evidence(evidence, page, block, source_sha256))
                continue
            if draft is None:
                warnings.append(
                    f'page {page.page} block {block.blockIndex}: narrative before first heading omitted'
                )
                continue
            draft.text_parts.append(text)
            draft.end_page = page.page
            draft.printed_end = page.printedPage
            draft.evidence_ids.append(_add_evidence(evidence, page, block, source_sha256))

    if draft is not None and draft.text_parts:
        provisions.append(_finalize(draft, titles))

    return NdaaConferenceLanguageExtractionResultV1(
        profileId=profile_id,
        sourceDocumentId=source_document_id,
        sourceSha256=source_sha256,
        provisions=provisions,
        evidence=evidence,
        warnings=warnings,
        omittedPages=sorted(omitted_pages),
    )


def _finalize(draft: _Draft, known_titles: list[str]) -> NdaaConferenceLanguageProvisionV1:
    full_text = '\n\n'.join(part.strip() for part in draft.text_parts if part.strip()).strip()
    haystack = f'{draft.heading}\n{full_text}'
    references = _extract_references(haystack, known_titles)
    scope = _scope(haystack, references)
    caveat = _caveat(scope)
    payload = {
        'stage': 'ndaa_conference',
        'sourceDocumentId': draft.source_document_id,
        'sourceSha256': draft.source_sha256,
        'fiscalYear': draft.fiscal_year,
        'heading': _normalize_text(draft.heading),
        'fullText': full_text,
        'startPage': draft.start_page,
        'endPage': draft.end_page,
    }
    provision_id = 'ndaa-language-' + hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()
    return NdaaConferenceLanguageProvisionV1(
        provisionId=provision_id,
        fiscalYear=draft.fiscal_year,
        profileId=draft.profile_id,
        sourceDocumentId=draft.source_document_id,
        sourceSha256=draft.source_sha256,
        heading=draft.heading,
        fullText=full_text,
        startPage=draft.start_page,
        endPage=draft.end_page,
        printedStart=draft.printed_start,
        printedEnd=draft.printed_end,
        actionType=_classify_action(full_text),
        deadline=_deadline(full_text),
        reportingRecipient=_recipient(full_text),
        references=references,
        scope=scope,
        attributionCaveat=caveat,
        chamberDispositions=chamber_dispositions(full_text),
        evidenceIds=list(dict.fromkeys(draft.evidence_ids)),
    )


def _add_evidence(
    evidence: list[NdaaConferenceLanguageEvidenceV1],
    page: ParserPageResultV1,
    block: LayoutBlockV1,
    source_sha256: str,
) -> str:
    payload = f'{source_sha256}|{page.page}|{block.blockIndex}|{block.text.strip()}'
    evidence_id = 'ndaa-language-evidence-' + hashlib.sha256(payload.encode('utf-8')).hexdigest()
    box = block.boundingBox
    evidence.append(
        NdaaConferenceLanguageEvidenceV1(
            evidenceId=evidence_id,
            sourceSha256=source_sha256,
            page=page.page,
            printedPage=page.printedPage,
            blockIndex=block.blockIndex,
            granularity='text_span' if box is not None else 'page_only',
            excerpt=block.text.strip(),
            boundingBox=(
                {
                    'x0': box.x0,
                    'y0': box.y0,
                    'x1': box.x1,
                    'y1': box.y1,
                }
                if box is not None
                else None
            ),
        )
    )
    return evidence_id
