import { DefenseResearchService } from './defense-research.service.js';
describe('DefenseResearchService comparison and evidence regressions', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const revisionId = '22222222-2222-4222-8222-222222222222';
  const at = new Date('2026-09-01');
  test('does not equate unrelated events simply because both subjects have milestones', async () => {
    const service = new DefenseResearchService({} as never);
    const proof = {
      evidenceRefId: `milestone-period:${id}`,
      sourceDocumentId: id,
      sourceRevisionId: null,
      sourceUrl: 'https://official.mil/r4.pdf',
      contentHash: 'a'.repeat(64),
      nativeLocator: { page: 1, section: null, occurrenceId: null },
    };
    const period = {
      role: 'planned',
      precision: 'calendar_month',
      rawText: 'March 2028',
      calendarYear: 2028,
      calendarMonth: 3,
      evidence: [proof],
    };
    (service as any).subjectLabel = async (type: string, subjectId: string) => ({
      type,
      id: subjectId,
      label: subjectId,
    });
    (service as any).fundingMatrix = async () => ({ cells: [] });
    (service as any).milestones = async (_type: string, subjectId: string) => ({
      milestones: [
        {
          label: subjectId === 'left' ? 'Development complete' : 'Testing begins',
          eventCategory: 'development',
          periods: [period],
        },
      ],
    });
    const result = await service.compare(['program_element:left', 'program_element:right']);
    expect(result.alignments.find((alignment) => alignment.kind === 'milestone')).toMatchObject({
      state: 'partial',
    });
  });
  test('resolves an emitted immutable section ref to its exact archived revision', async () => {
    const revision = {
      id: revisionId,
      sourceDocumentId: id,
      contentHash: 'a'.repeat(64),
      version: 'v1',
      sourceUrl: 'https://official.mil/policy',
      observedAt: at,
      document: { eligible: true, qualification: 'qualified', family: 'policy', publisher: 'DoD' },
    };
    const prisma = {
      defenseContextSection: {
        findUnique: jest.fn().mockResolvedValue({ nativeLocator: 'Section 4', revision }),
      },
    };
    const service = new DefenseResearchService(prisma as never);
    expect(await service.resolveEvidence(`context-compare:${id}`)).toMatchObject({
      evidenceRefId: `context-compare:${id}`,
      sourceRevisionId: revisionId,
      contentHash: 'a'.repeat(64),
      nativeLocator: { section: 'Section 4' },
      availability: 'available',
    });
  });
  test('resolves URL-only office context as partial and refuses nonaccepted personnel roles', async () => {
    const prisma = {
      programOffice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ sourceUrl: 'https://army.mil/office', updatedAt: at }),
      },
      personRole: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new DefenseResearchService(prisma as never);
    expect(await service.resolveEvidence(`office:${id}`)).toMatchObject({
      contentHash: null,
      sourceDocumentId: null,
      availability: 'partial',
      nativeLocator: { page: null, section: null, occurrenceId: null },
    });
    await expect(service.resolveEvidence(`person-role:${id}`)).rejects.toThrow(
      'Evidence reference not found',
    );
    expect(prisma.personRole.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id, reviewStatus: 'accepted' },
        select: { source: true, sourceUrl: true, observedAt: true },
      }),
    );
  });
});
