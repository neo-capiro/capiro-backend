import { DefenseResearchService } from './defense-research.service.js';
const documentId = '11111111-1111-4111-8111-111111111111',
  revisionId = '22222222-2222-4222-8222-222222222222',
  sectionId = '33333333-3333-4333-8333-333333333333';
describe('Defense Compare exact saved revision inputs', () => {
  test('reads pinned archived revision/selected native sections rather than newer current revision', async () => {
    const section = {
      id: sectionId,
      label: 'Section 4',
      nativeLocator: 'Section 4',
      contentText: 'Captured older wording',
      textAvailability: 'available',
    };
    const document = {
      id: documentId,
      title: 'Policy',
      family: 'policy',
      publisher: 'DoD',
      eligible: true,
      qualification: 'qualified',
      sourceUrl: 'https://official.mil/context',
      currentRevision: { id: 'new', sections: [{ ...section, contentText: 'New wording' }] },
    };
    const findFirst = jest
      .fn()
      .mockResolvedValue({
        id: revisionId,
        version: 'old',
        contentHash: 'a'.repeat(64),
        observedAt: new Date('2026-09-01'),
        sourceDocumentId: documentId,
        sourceUrl: document.sourceUrl,
        sections: [section],
      });
    const service = new DefenseResearchService({
      defenseContextDocument: { findUnique: jest.fn().mockResolvedValue(document) },
      defenseContextDocumentRevision: { findFirst },
    } as any);
    const result = await service.compare(
      ['context_document:' + documentId, 'context_document:44444444-4444-4444-8444-444444444444'],
      { contextualRevisionPins: [{ documentId, revisionId, sectionIds: [sectionId] }] },
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: revisionId, documentId },
        include: expect.objectContaining({
          sections: expect.objectContaining({ where: { id: { in: [sectionId] } } }),
        }),
      }),
    );
    expect(result.metrics[0]?.cells[0]?.value).toBe('Captured older wording');
    expect(result.metrics[0]?.cells[0]?.evidence[0]?.sourceRevisionId).toBe(revisionId);
  });
});
