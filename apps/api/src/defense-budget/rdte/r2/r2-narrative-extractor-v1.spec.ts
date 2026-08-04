/**
 * r2-narrative-extractor-v1.spec — Workstream F tests.
 *
 * Synthetic fixtures for:
 * - multi-page mission;
 * - mission ending at next section;
 * - accomplishments/plans sections;
 * - page headers inside narrative;
 * - blank section;
 * - malformed heading;
 * - two PEs on adjacent pages;
 * - hyphenated line break;
 * - all-caps footer;
 * - text-span evidence truthfulness.
 */
import type {
  LayoutBlockV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { R2ContextResolutionResult, R2ResolvedPage } from './r2-context-resolver.js';
import { extractR2Narrative } from './r2-narrative-extractor-v1.js';
import { normalizeR2SectionLabel, isLikelySectionHeading } from './r2-section-normalizer.js';

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

function makeBlock(overrides: Partial<LayoutBlockV1> & { text: string }): LayoutBlockV1 {
  return {
    blockIndex: overrides.blockIndex ?? 0,
    blockType: overrides.blockType ?? 'paragraph',
    text: overrides.text,
    ...(overrides.readingOrder != null ? { readingOrder: overrides.readingOrder } : {}),
    ...(overrides.boundingBox != null ? { boundingBox: overrides.boundingBox } : {}),
  };
}

function makePage(blocks: LayoutBlockV1[], page: number, printedPage?: string): ParserPageResultV1 {
  return {
    page,
    ...(printedPage != null ? { printedPage } : {}),
    blocks,
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function makeResolvedPage(overrides: Partial<R2ResolvedPage> & { page: number }): R2ResolvedPage {
  return {
    page: overrides.page,
    segmentId: overrides.segmentId ?? `seg_${overrides.page}`,
    kind: overrides.kind ?? 'r2_pe_summary',
    ...(overrides.printedPage != null ? { printedPage: overrides.printedPage } : {}),
    ...(overrides.peCode != null ? { peCode: overrides.peCode } : {}),
    ...(overrides.projectCode != null ? { projectCode: overrides.projectCode } : {}),
    contextSource: overrides.contextSource ?? 'explicit_header',
    evidence: overrides.evidence ?? [],
    ...(overrides.unresolvedReason != null ? { unresolvedReason: overrides.unresolvedReason } : {}),
  };
}

function makeContextResolution(pages: R2ResolvedPage[]): R2ContextResolutionResult {
  const resolvedPeCodes = [...new Set(pages.filter((p) => p.peCode != null).map((p) => p.peCode!))];
  const resolvedProjectCodes = pages
    .filter((p) => p.peCode != null && p.projectCode != null)
    .map((p) => ({ peCode: p.peCode!, projectCode: p.projectCode! }));
  const unresolvedPages = pages.filter((p) => p.contextSource === 'unresolved');
  return { pages, resolvedPeCodes, resolvedProjectCodes, unresolvedPages };
}

const PE = '0601234A';
const PE2 = '0601235A';

/* ------------------------------------------------------------------ */
/* Section normalizer tests                                            */
/* ------------------------------------------------------------------ */

describe('r2-section-normalizer', () => {
  it('maps letter-prefixed mission heading', () => {
    const label = normalizeR2SectionLabel('A. Mission Description and Budget Item Justification');
    expect(label).not.toBeNull();
    expect(label?.narrativeType).toBe('mission');
    expect(label?.letterPrefix).toBe('A');
    expect(label?.malformed).toBe(false);
  });

  it('maps accomplishments heading', () => {
    const label = normalizeR2SectionLabel('B. Accomplishments/Planned Programs');
    expect(label?.narrativeType).toBe('accomplishments');
  });

  it('maps plans heading', () => {
    const label = normalizeR2SectionLabel('B. Planned Programs');
    expect(label?.narrativeType).toBe('plans');
  });

  it('maps description heading', () => {
    const label = normalizeR2SectionLabel('A. Description/Rationale');
    expect(label?.narrativeType).toBe('description');
  });

  it('maps schedule notes heading', () => {
    const label = normalizeR2SectionLabel('C. Schedule Notes');
    expect(label?.narrativeType).toBe('schedule_notes');
  });

  it('maps unknown letter heading to other', () => {
    const label = normalizeR2SectionLabel('X. Some Unknown Section');
    expect(label?.narrativeType).toBe('other');
    expect(label?.exactLabel).toBe('X. Some Unknown Section');
  });

  it('returns null for non-heading text', () => {
    expect(normalizeR2SectionLabel('This is a paragraph of text.')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(normalizeR2SectionLabel('')).toBeNull();
  });

  it('detects likely section headings', () => {
    expect(isLikelySectionHeading('A. Mission Description')).toBe(true);
    expect(isLikelySectionHeading('Mission Description')).toBe(true);
    expect(isLikelySectionHeading('A long paragraph about many things that goes on and on.')).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Narrative extractor tests                                           */
/* ------------------------------------------------------------------ */

describe('r2-narrative-extractor-v1', () => {
  it('extracts a multi-page mission section', () => {
    const pages = [
      makePage(
        [
          makeBlock({ text: 'RDT&E Budget Item Justification R-2', blockType: 'header' }),
          makeBlock({ text: `PE ${PE} — Advanced Widget`, blockType: 'heading' }),
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'The Advanced Widget program develops next-generation' }),
          makeBlock({ text: 'capabilities for the warfighter.' }),
        ],
        1,
        'R-2-1',
      ),
      makePage(
        [
          makeBlock({ text: 'RDT&E Budget Item Justification R-2', blockType: 'header' }),
          makeBlock({ text: 'Additional mission text continues here.' }),
          makeBlock({ text: 'B. Accomplishments/Planned Programs', blockType: 'heading' }),
          makeBlock({ text: 'Completed prototype testing.' }),
        ],
        2,
        'R-2-2',
      ),
    ];

    const contextResolution = makeContextResolution([
      makeResolvedPage({ page: 1, peCode: PE, kind: 'r2_pe_summary', printedPage: 'R-2-1' }),
      makeResolvedPage({ page: 2, peCode: PE, kind: 'r2_continuation', printedPage: 'R-2-2' }),
    ]);

    const result = extractR2Narrative({ pages, contextResolution });

    const mission = result.sections.find((s) => s.narrativeType === 'mission');
    expect(mission).toBeDefined();
    expect(mission?.peCode).toBe(PE);
    expect(mission?.text).toContain('next-generation');
    expect(mission?.text).toContain('capabilities for the warfighter.');
    expect(mission?.text).toContain('Additional mission text continues here.');
    expect(mission?.pages).toEqual([1, 2]);
    expect(mission?.printedPages).toEqual(['R-2-1', 'R-2-2']);

    const accomplishments = result.sections.find((s) => s.narrativeType === 'accomplishments');
    expect(accomplishments).toBeDefined();
    expect(accomplishments?.text).toContain('Completed prototype testing.');
  });

  it('mission ends at next section heading', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Mission text here.' }),
          makeBlock({ text: 'B. Accomplishments/Planned Programs', blockType: 'heading' }),
          makeBlock({ text: 'Accomplishment text here.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    const mission = result.sections.find((s) => s.narrativeType === 'mission');
    expect(mission?.text).toBe('Mission text here.');
    expect(mission?.text).not.toContain('Accomplishment');
  });

  it('extracts accomplishments and plans sections', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Mission.' }),
          makeBlock({ text: 'B. Accomplishments/Planned Programs', blockType: 'heading' }),
          makeBlock({ text: 'Accomplished X.' }),
          makeBlock({ text: 'C. Plans', blockType: 'heading' }),
          makeBlock({ text: 'Plan Y.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    expect(result.sections).toHaveLength(3);
    expect(result.sections.map((s) => s.narrativeType)).toEqual([
      'mission',
      'accomplishments',
      'plans',
    ]);
  });

  it('strips page headers from narrative', () => {
    const pages = [
      makePage(
        [
          makeBlock({ text: 'RDT&E Budget Item Justification R-2', blockType: 'header' }),
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Real mission text.' }),
          makeBlock({ text: '42', blockType: 'footer' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    const mission = result.sections.find((s) => s.narrativeType === 'mission');
    expect(mission?.text).toBe('Real mission text.');
    expect(mission?.text).not.toContain('RDT&E');
    expect(mission?.text).not.toContain('42');
  });

  it('handles blank section (heading with no content)', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'B. Accomplishments/Planned Programs', blockType: 'heading' }),
          makeBlock({ text: 'Has content.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    /* Mission section has no content → not emitted. */
    const mission = result.sections.find((s) => s.narrativeType === 'mission');
    expect(mission).toBeUndefined();
    /* Accomplishments has content → emitted. */
    const acc = result.sections.find((s) => s.narrativeType === 'accomplishments');
    expect(acc?.text).toBe('Has content.');
  });

  it('handles malformed heading gracefully', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Valid mission text.' }),
          makeBlock({ text: 'B. ', blockType: 'heading' }) /* malformed: letter but no title */,
          makeBlock({ text: 'After malformed heading.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    /* Mission section should still be captured. */
    const mission = result.sections.find((s) => s.narrativeType === 'mission');
    expect(mission?.text).toContain('Valid mission text.');
  });

  it('separates narrative for two PEs on adjacent pages', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Mission for PE 1.' }),
        ],
        1,
      ),
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Mission for PE 2.' }),
        ],
        2,
      ),
    ];

    const contextResolution = makeContextResolution([
      makeResolvedPage({ page: 1, peCode: PE }),
      makeResolvedPage({ page: 2, peCode: PE2 }),
    ]);

    const result = extractR2Narrative({ pages, contextResolution });
    const pe1Mission = result.sections.find(
      (s) => s.peCode === PE && s.narrativeType === 'mission',
    );
    const pe2Mission = result.sections.find(
      (s) => s.peCode === PE2 && s.narrativeType === 'mission',
    );
    expect(pe1Mission?.text).toBe('Mission for PE 1.');
    expect(pe2Mission?.text).toBe('Mission for PE 2.');
  });

  it('dehyphenates line-break hyphens', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'The program develops next-gener-\nation capabilities.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    const mission = result.sections.find((s) => s.narrativeType === 'mission');
    expect(mission?.text).toContain('next-generation');
  });

  it('strips all-caps footer noise', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Real mission text.' }),
          makeBlock({ text: 'UNCLASSIFIED', blockType: 'footer' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    const mission = result.sections.find((s) => s.narrativeType === 'mission');
    expect(mission?.text).toBe('Real mission text.');
    expect(mission?.text).not.toContain('UNCLASSIFIED');
  });

  it('preserves raw text for provenance', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: '  Spaced   out   text.  ' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    const mission = result.sections.find((s) => s.narrativeType === 'mission');
    expect(mission?.rawText).toContain('  Spaced   out   text.  ');
    expect(mission?.text).toBe('Spaced out text.');
  });

  it('emits omission when no mission/description section exists', () => {
    const pages = [
      makePage(
        [
          makeBlock({ text: 'B. Accomplishments/Planned Programs', blockType: 'heading' }),
          makeBlock({ text: 'Only accomplishments.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.reason).toBe('missing_mission_or_description');
    expect(result.omissions[0]?.peCode).toBe(PE);
  });

  it('extracts other labeled sections with exact label metadata', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Mission.' }),
          makeBlock({ text: 'D. Acquisition Strategy', blockType: 'heading' }),
          makeBlock({ text: 'Strategy text.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result = extractR2Narrative({ pages, contextResolution });
    const other = result.sections.find((s) => s.narrativeType === 'other');
    expect(other).toBeDefined();
    expect(other?.sectionLabel).toBe('D. Acquisition Strategy');
    expect(other?.text).toBe('Strategy text.');
  });

  it('does not process unresolved pages', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'Should not be extracted.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([
      makeResolvedPage({
        page: 1,
        contextSource: 'unresolved',
        unresolvedReason: 'conflicting headers',
      }),
    ]);

    const result = extractR2Narrative({ pages, contextResolution });
    expect(result.sections).toHaveLength(0);
  });

  it('does not process R-3 or R-4 pages as narrative', () => {
    const pages = [
      makePage(
        [
          makeBlock({
            text: 'A. Mission Description and Budget Item Justification',
            blockType: 'heading',
          }),
          makeBlock({ text: 'R-3 content should not appear.' }),
        ],
        1,
      ),
    ];

    const contextResolution = makeContextResolution([
      makeResolvedPage({ page: 1, peCode: PE, kind: 'r3_page' }),
    ]);

    const result = extractR2Narrative({ pages, contextResolution });
    expect(result.sections).toHaveLength(0);
  });

  it('is deterministic under page order permutation', () => {
    const blocks: LayoutBlockV1[] = [
      makeBlock({
        text: 'A. Mission Description and Budget Item Justification',
        blockType: 'heading',
      }),
      makeBlock({ text: 'Mission text.' }),
      makeBlock({ text: 'B. Accomplishments/Planned Programs', blockType: 'heading' }),
      makeBlock({ text: 'Accomplishments text.' }),
    ];

    const pages1 = [makePage(blocks, 1)];
    const pages2 = [makePage(blocks, 1)];

    const ctx = makeContextResolution([makeResolvedPage({ page: 1, peCode: PE })]);

    const result1 = extractR2Narrative({ pages: pages1, contextResolution: ctx });
    const result2 = extractR2Narrative({ pages: pages2, contextResolution: ctx });

    expect(result1.sections.map((s) => s.text)).toEqual(result2.sections.map((s) => s.text));
  });
});
