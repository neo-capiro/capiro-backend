import { NotFoundException } from '@nestjs/common';
import { DefenseResearchService } from './defense-research.service.js';
import { DefenseResearchController } from './defense-research.controller.js';
import { coverageRecordedOutcome } from './defense-coverage-outcomes.js';

const id = '00000000-0000-4000-8000-000000000001';
const revisionId = '00000000-0000-4000-8000-000000000002';
const at = new Date('2026-10-27T00:00:00.000Z');
function occurrence() {
  return {
    id,
    documentId: id,
    revisionId,
    sectionId: id,
    exactSpan: 'target',
    startOffset: 2,
    endOffset: 8,
    document: {
      eligible: true,
      qualification: 'qualified',
      family: 'context',
      publisher: 'Public source',
    },
    revision: {
      id: revisionId,
      documentId: id,
      sourceDocumentId: id,
      contentHash: 'a'.repeat(64),
      sourceUrl: 'https://example.invalid/source',
      version: '1',
      observedAt: at,
    },
    section: { id, revisionId, contentText: 'a target z', nativeLocator: 'section 1' },
  };
}

describe('native evidence details', () => {
  it('reads verified persisted offsets without changing the internal publication shape', async () => {
    const row = occurrence();
    const service = new DefenseResearchService({
      defenseReferenceOccurrence: { findUnique: async () => row },
    } as never);
    const internal = await service.resolveEvidence(`context-occurrence:${id}`);
    expect(internal.nativeLocator.details).toBeUndefined();
    const native = await service.readEvidenceDetails(`context-occurrence:${id}`);
    expect(native.nativeLocator.details).toMatchObject({
      availability: 'available',
      textSpan: { start: 2, end: 8 },
    });
    expect(await service.referenceOccurrence(id)).toMatchObject({ startOffset: 2, endOffset: 8 });
  });
  it.each(['mismatched section', 'mismatched span', 'missing text'])(
    'withholds unproven offsets: %s',
    async (kind) => {
      const row = occurrence();
      if (kind === 'mismatched section') row.section.revisionId = id;
      if (kind === 'mismatched span') row.endOffset = 9;
      if (kind === 'missing text') row.section.contentText = '';
      const service = new DefenseResearchService({
        defenseReferenceOccurrence: { findUnique: async () => row },
      } as never);
      expect(
        (await service.readEvidenceDetails(`context-occurrence:${id}`)).nativeLocator.details,
      ).toMatchObject({ availability: 'unavailable', textSpan: null });
    },
  );
  it('rechecks qualification and revision identity at the detailed read', async () => {
    const row = occurrence();
    const repository = {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ ...row, document: { ...row.document, eligible: false } }),
    };
    await expect(
      new DefenseResearchService({
        defenseReferenceOccurrence: repository,
      } as never).readEvidenceDetails(`context-occurrence:${id}`),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('uses the native detailed owner at the existing controller', async () => {
    const readEvidenceDetails = jest.fn().mockResolvedValue({ evidenceRefId: 'native' });
    expect(
      await new DefenseResearchController({ readEvidenceDetails } as never).evidence('native'),
    ).toEqual({ evidenceRefId: 'native' });
  });
});

describe('recorded Coverage outcomes', () => {
  it('does not label a current published state or missing audit as a successful recheck', () => {
    expect(
      coverageRecordedOutcome({ expectedState: 'published', observations: [] }, undefined),
    ).toMatchObject({
      sourceState: 'published',
      lastObservation: null,
      lastGovernedResolution: null,
    });
  });
  it('keeps observed outcome and governed resolution distinct, including refusal states', () => {
    expect(
      coverageRecordedOutcome(
        {
          expectedState: 'unavailable',
          observations: [{ observationState: 'blocked', revisionKind: 'changed', lastSeenAt: at }],
        },
        { decision: 'unavailable', resolvedAt: at },
      ),
    ).toMatchObject({
      lastObservation: { state: 'blocked', revisionKind: 'changed', observedAt: at.toISOString() },
      lastGovernedResolution: { decision: 'unavailable', resolvedAt: at.toISOString() },
    });
  });
  it('reads only the requested cohort and current tenant audit fields; private audit is not projected', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ expectedSourceId: id, decision: 'published', resolvedAt: at }]);
    const prisma = {
      defenseBudgetExpectedSource: {
        findMany: jest.fn().mockResolvedValue([
          {
            id,
            authorityTrack: 'appropriations',
            fiscalYear: 2027,
            sourceFamily: 'pb_r2',
            component: 'ARMY',
            stage: 'request',
            expectedState: 'published',
            optional: false,
            metadata: {},
            observations: [],
            bundleMembers: [],
          },
        ]),
      },
      withTenant: jest.fn(async (_tenant: string, read: (tx: unknown) => Promise<unknown>) =>
        read({ defenseBudgetReviewResolution: { findMany } }),
      ),
      defenseBudgetActiveSnapshot: { findUnique: async () => null },
    };
    const service = new DefenseResearchService(prisma as never);
    const ctx = { tenantId: id } as never;
    const response = await service.productCoverage({ fiscalYear: 2027 }, ctx);
    expect(prisma.withTenant).toHaveBeenCalledWith(id, expect.any(Function), { readOnly: true });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: id, expectedSourceId: { in: [id] } },
        select: { expectedSourceId: true, decision: true, resolvedAt: true },
      }),
    );
    expect(response.rows[0]?.denominator.state).toBe('unknown');
    expect(response.rows[0]?.recordedOutcome?.lastGovernedResolution?.decision).toBe('published');
    findMany.mockClear();
    expect(
      (await service.productCoverage({ fiscalYear: 2027 })).rows[0]?.recordedOutcome
        ?.lastGovernedResolution,
    ).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('actorUserId');
    expect(JSON.stringify(response)).not.toContain('tenantId');
  });
});
