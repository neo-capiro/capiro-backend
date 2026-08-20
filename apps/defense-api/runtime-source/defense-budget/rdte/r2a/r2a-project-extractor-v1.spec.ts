/**
 * r2a-project-extractor-v1.spec — Workstream H tests.
 *
 * Synthetic fixtures for:
 *   - standard R-2A project page with identity + narrative;
 *   - 2-character project code;
 *   - 8-character project code with punctuation;
 *   - repeated project headers;
 *   - same project over multiple pages;
 *   - conflicting titles;
 *   - project with no parent PE;
 *   - mission/accomplishments/plans sections;
 *   - R-2A page mislabeled as R-2;
 *   - project code containing punctuation allowed by policy;
 *   - no truncation of long project codes.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import {
  extractR2aProjectsFromGroups,
  extractR2aProjectsFromPages,
} from './r2a-project-extractor-v1.js';

function makePage(
  page: number,
  blocks: Array<{
    blockIndex: number;
    blockType:
      | 'text'
      | 'heading'
      | 'paragraph'
      | 'list_item'
      | 'table'
      | 'image'
      | 'header'
      | 'footer'
      | 'caption'
      | 'unknown';
    text: string;
    readingOrder?: number;
  }>,
  text?: string,
  printedPage?: string,
): ParserPageResultV1 {
  return {
    page,
    text,
    ...(printedPage != null ? { printedPage } : {}),
    blocks: blocks.map((b) => ({
      blockIndex: b.blockIndex,
      blockType: b.blockType,
      text: b.text,
      ...(b.readingOrder != null ? { readingOrder: b.readingOrder } : {}),
    })),
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

describe('r2a-project-section-extractor', () => {
  it('extracts mission, accomplishments, and plans sections', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research Project' },
      { blockIndex: 4, blockType: 'heading', text: 'Mission' },
      { blockIndex: 5, blockType: 'paragraph', text: 'Conduct basic research.' },
      { blockIndex: 6, blockType: 'heading', text: 'Accomplishments' },
      { blockIndex: 7, blockType: 'paragraph', text: 'Published three papers.' },
      { blockIndex: 8, blockType: 'heading', text: 'Plans' },
      { blockIndex: 9, blockType: 'paragraph', text: 'Continue research.' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    expect(result.narratives.length).toBeGreaterThanOrEqual(3);
    const kinds = result.narratives.map((n) => n.kind);
    expect(kinds).toContain('mission');
    expect(kinds).toContain('accomplishments');
    expect(kinds).toContain('plans');
  });

  it('handles description section', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: XY' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Test' },
      { blockIndex: 4, blockType: 'heading', text: 'Description' },
      { blockIndex: 5, blockType: 'paragraph', text: 'Detailed description text.' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.narratives.some((n) => n.kind === 'description')).toBe(true);
  });

  it('skips non-narrative blocks like footers and page numbers', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research' },
      { blockIndex: 4, blockType: 'heading', text: 'Mission' },
      { blockIndex: 5, blockType: 'paragraph', text: 'Real mission text.' },
      { blockIndex: 6, blockType: 'footer', text: 'Page 42' },
      { blockIndex: 7, blockType: 'text', text: 'R-2A' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    const mission = result.narratives.find((n) => n.kind === 'mission');
    expect(mission?.text).toBe('Real mission text.');
  });
});

describe('r2a-project-extractor-v1', () => {
  it('extracts a standard R-2A project identity', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research Project' },
      { blockIndex: 4, blockType: 'text', text: 'Budget Activity: BA 1' },
      { blockIndex: 5, blockType: 'heading', text: 'Mission' },
      { blockIndex: 6, blockType: 'paragraph', text: 'Conduct research.' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    const id = result.identities[0]!;
    expect(id.parentPeCode).toBe('0601101A');
    expect(id.projectCode).toBe('AB1');
    expect(id.title).toBe('Research Project');
    expect(id.budgetActivity).toBe('BA 1');
    expect(id.pages).toEqual([1]);
  });

  it('handles 2-character project codes', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: A1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Short Code' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe('A1');
  });

  it('handles 8-character project codes with punctuation', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB-12.34' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Long Code' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe('AB-12.34');
  });

  it('does not truncate long project codes', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: ABCDEFGHIJ' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Very Long Code' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe('ABCDEFGHIJ');
  });

  it('handles repeated project headers across pages', () => {
    const page1 = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research' },
      { blockIndex: 4, blockType: 'heading', text: 'Mission' },
      { blockIndex: 5, blockType: 'paragraph', text: 'First part.' },
    ]);
    const page2 = makePage(2, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research' },
      { blockIndex: 4, blockType: 'heading', text: 'Accomplishments' },
      { blockIndex: 5, blockType: 'paragraph', text: 'Second part.' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page1, page2] });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.pages).toEqual([1, 2]);
    expect(result.narratives.some((n) => n.kind === 'mission')).toBe(true);
    expect(result.narratives.some((n) => n.kind === 'accomplishments')).toBe(true);
  });

  it('detects conflicting titles across pages', () => {
    const page1 = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research Alpha' },
    ]);
    const page2 = makePage(2, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research Beta' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page1, page2] });
    expect(result.identities[0]?.title).toBe('Research Alpha');
    expect(result.identities[0]?.aliases).toContain('Research Beta');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.field).toBe('title');
    expect(result.conflicts[0]?.values).toContain('Research Alpha');
    expect(result.conflicts[0]?.values).toContain('Research Beta');
  });

  it('blocks project with no valid parent PE', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 2, blockType: 'text', text: 'Project Title: No PE' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.reason).toBe('missing_or_invalid_parent_pe');
  });

  it('handles invalid project code as omission', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB 1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Bad Code' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(0);
    expect(result.omissions.some((o) => o.reason === 'invalid_project_code')).toBe(true);
  });

  it('skips R-2A pages mislabeled as R-2', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Mislabeled' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(0);
  });

  it('inherits budget activity from PE context when not printed', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research' },
    ]);
    const result = extractR2aProjectsFromPages({
      pages: [page],
      peContext: { budgetActivity: 'BA 2', budgetActivityName: 'Applied Research' },
    });
    expect(result.identities[0]?.budgetActivity).toBe('BA 2');
    expect(result.identities[0]?.budgetActivityName).toBe('Applied Research');
  });

  it('handles project with no narrative sections', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Bare Project' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    expect(result.narratives).toHaveLength(0);
  });

  it('handles project code with punctuation allowed by policy', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: A.1-B' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Punctuation' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe('A.1-B');
  });

  it('produces omission when project title is missing', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.title).toBe('');
    expect(result.omissions.some((o) => o.reason === 'missing_project_title')).toBe(true);
  });

  it('extracts from pre-segmented groups', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Grouped' },
    ]);
    const result = extractR2aProjectsFromGroups({
      groups: [
        {
          parentPeCode: '0601101A',
          projectCode: 'AB1',
          pages: [page],
        },
      ],
    });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.title).toBe('Grouped');
  });

  it('detects conflicts across duplicate groups', () => {
    const page1 = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Alpha' },
    ]);
    const page2 = makePage(2, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Beta' },
    ]);
    const result = extractR2aProjectsFromGroups({
      groups: [
        { parentPeCode: '0601101A', projectCode: 'AB1', pages: [page1] },
        { parentPeCode: '0601101A', projectCode: 'AB1', pages: [page2] },
      ],
    });
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it('preserves narrative text exactly without summarization', () => {
    const page = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Research' },
      { blockIndex: 4, blockType: 'heading', text: 'Mission' },
      {
        blockIndex: 5,
        blockType: 'paragraph',
        text: 'This is a very specific mission statement that must not be altered.',
      },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    const mission = result.narratives.find((n) => n.kind === 'mission');
    expect(mission?.text).toBe(
      'This is a very specific mission statement that must not be altered.',
    );
  });

  it('handles multiple projects on the same parent PE', () => {
    const page1 = makePage(1, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: AB1' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: First' },
    ]);
    const page2 = makePage(2, [
      { blockIndex: 0, blockType: 'header', text: 'R-2A' },
      { blockIndex: 1, blockType: 'text', text: 'PE 0601101A' },
      { blockIndex: 2, blockType: 'text', text: 'Project Code: CD2' },
      { blockIndex: 3, blockType: 'text', text: 'Project Title: Second' },
    ]);
    const result = extractR2aProjectsFromPages({ pages: [page1, page2] });
    expect(result.identities).toHaveLength(2);
    const codes = result.identities.map((i) => i.projectCode).sort();
    expect(codes).toEqual(['AB1', 'CD2']);
  });
});
