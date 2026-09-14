import { extractCitationsFromToolResult } from '@capiro/shared';
import { projectMeriToolEvidence } from './meriv3-tool-evidence.js';

describe('Phase 8 model-visible fiscal evidence', () => {
  const fixture = () => ({
    tool: 'get_florida_budget_project',
    result: {
      scope: { folderId: 'internal-owned', clientId: null },
      fiscalYear: '2026-27',
      nextOffset: null,
      projects: [
        {
          id: 'FL:2026-27:H1:S1',
          title: 'Synthetic project',
          identities: ['House H1', 'Senate S1'],
        },
      ],
      amounts: ['House', 'Senate'].map((chamber, i) => ({
        id: 'amount-' + i,
        observation: {
          chamber,
          stage: 'chamber_proposal',
          minorUnits: i ? '5400000' : '5000000',
          fund: 'General Revenue',
          basis: 'total',
          allocationBasis: 'published-project-column-total',
          measure: 'money',
          currency: 'USD',
          unitMultiplier: '1',
          periodStart: '2026-07-01',
          periodEnd: '2027-06-30',
          sourceRevision: 'exact-sha256',
          documentId: 'doc-1',
          locator: 'pdf-index:1;column:' + chamber,
        },
      })),
      documents: [
        {
          id: 'doc-1',
          title: 'Synthetic chamber comparison',
          source_url: 'https://example.gov/budget.pdf',
          content_hash: 'exact-sha256',
          stage: 'chamber_proposal',
          complete: true,
          metadata: {
            coverage: 'Selected published project rows',
            ancillaryManifest: 'x'.repeat(14000),
          },
        },
      ],
      events: [{ kind: 'new_document', sourceId: 'doc-1' }],
    },
  });
  it('keeps exact amounts, bases and revisions while making original-source citations available', () => {
    const original = fixture();
    expect(JSON.stringify(original).length).toBeGreaterThan(12000);
    const visible = projectMeriToolEvidence({
      result: original,
      maxCharacters: 12000,
      readOnly: true,
    }) as any;
    expect(visible.result.amounts).toEqual(original.result.amounts);
    expect(visible.result.projects).toEqual(original.result.projects);
    expect(visible.result.events).toEqual(original.result.events);
    expect(visible.data[0].sourceRevision).toBe('exact-sha256');
    expect(visible.data[0].coverage).toBe('Selected published project rows');
    expect(JSON.stringify(visible).length).toBeLessThanOrEqual(12000);
    expect(extractCitationsFromToolResult(original.tool, visible, 1)[0]?.url).toBe(
      'https://example.gov/budget.pdf',
    );
    expect(visible.projection.documentMetadataSummarized).toBe(true);
  });
  it('preserves scope and leaves the caller data unchanged', () => {
    const original = fixture();
    const before = JSON.stringify(original);
    const visible = projectMeriToolEvidence({
      result: original,
      maxCharacters: 12000,
      readOnly: true,
    }) as any;
    expect(JSON.stringify(original)).toBe(before);
    expect(visible.result.scope).toEqual(original.result.scope);
    expect(visible.result.nextOffset).toBeNull();
  });
  it('does not claim a too-large monetary observation was preserved', () => {
    const original = fixture();
    (original.result.amounts[0]!.observation as any).proviso = 'x'.repeat(16000);
    const visible = projectMeriToolEvidence({
      result: original,
      maxCharacters: 12000,
      readOnly: true,
    }) as any;
    expect(visible.truncated).toBe(true);
    expect(visible.projection.monetaryObservationsPreserved).not.toBe(true);
  });
});
