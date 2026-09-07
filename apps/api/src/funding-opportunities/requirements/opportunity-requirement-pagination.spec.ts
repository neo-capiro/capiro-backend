import {
  OpportunityRequirementService,
  type RequirementPort,
} from './opportunity-requirement.service.js';

const SOURCE_ID = '44444444-4444-4444-4444-444444444444';
const AS_OF = new Date('2026-09-06T12:00:00Z');

function fixture(total: number) {
  const records = Array.from({ length: total }, (_, index) => ({
    id: `requirement-${index}`,
    attachmentId: `attachment-${Math.floor(index / 100)}`,
    requirementType: 'submission',
    statement: `Condition ${index}`,
    sourceExcerpt: `Source condition ${index}`,
    excerptStart: index * 100,
    excerptEnd: index * 100 + `Source condition ${index}`.length,
    sourcePage: index + 1,
    fileName: 'solicitation.pdf',
    extractionMethod: 'model',
    extractionModel: 'existing-extractor',
    confidence: 'medium',
    supersededAt: null,
  }));
  const port: RequirementPort = {
    readRequirements: jest.fn(async (_id, page) =>
      records.slice(page?.offset ?? 0, (page?.offset ?? 0) + (page?.limit ?? 500)),
    ),
    countRequirements: jest.fn(async () => records.length),
    readReviews: jest.fn(
      async (tenantId, ids) =>
        new Map(
          ids
            .slice(0, 1)
            .map((id) => [
              id,
              tenantId === 'tenant-a' ? ('accepted' as const) : ('rejected' as const),
            ]),
        ),
    ),
    countArchivedDocuments: async () => (records.length ? 1 : 0),
    readTextStatus: async () =>
      records.length ? [{ fileName: 'solicitation.pdf', status: 'available' }] : [],
  };
  const service = new OpportunityRequirementService({} as never).withPort(port);
  return { service, port, records };
}

describe('canonical requirement continuation', () => {
  it('reads past the former 500-row ceiling without losing citations or tenant review scope', async () => {
    const { service, port, records } = fixture(1203);
    const collected: string[] = [];
    let offset = 0;
    do {
      const result = await service.getRequirements('tenant-a', 'sam_gov', SOURCE_ID, AS_OF, {
        offset,
        limit: 500,
      });
      expect(result.pagination.total).toBe(1203);
      expect(result.requirements[0]!.reviewStatus).toBe('accepted');
      expect(result.requirements[0]!.attachmentId).toBe(records[offset]!.attachmentId);
      expect(result.requirements[0]!.sourcePage).toBe(records[offset]!.sourcePage);
      expect(result.requirements[0]!.sourceExcerpt).toBe(records[offset]!.sourceExcerpt);
      collected.push(...result.requirements.map((row) => row.id));
      if (result.pagination.nextOffset == null) break;
      offset = result.pagination.nextOffset;
    } while (offset < records.length);
    expect(collected).toEqual(records.map((row) => row.id));
    expect(new Set(collected).size).toBe(1203);
    expect(port.readReviews).toHaveBeenCalledTimes(3);
    const otherTenant = await service.getRequirements('tenant-b', 'sam_gov', SOURCE_ID, AS_OF, {
      offset: 1000,
      limit: 10,
    });
    expect(otherTenant.requirements[0]!.reviewStatus).toBe('rejected');
    expect(otherTenant.requirements[1]!.reviewStatus).toBe('pending');
  });

  it('does not present an exhausted page as no conditions in the document', async () => {
    const { service } = fixture(12);
    const result = await service.getRequirements('tenant-a', 'sam_gov', SOURCE_ID, AS_OF, {
      offset: 20,
      limit: 10,
    });
    expect(result.requirements).toEqual([]);
    expect(result.coverage).toBe('available');
    expect(result.pagination).toEqual({
      offset: 20,
      limit: 10,
      total: 12,
      hasMore: false,
      nextOffset: null,
    });
    expect(result.coverageExplanation).toContain('0 requirements returned of 12');
  });

  it('offers continuation when a newer count sees an extraction appended after the page read', async () => {
    const { service, port } = fixture(10);
    port.countRequirements = async () => 12;
    const result = await service.getRequirements('tenant-a', 'sam_gov', SOURCE_ID, AS_OF, {
      limit: 10,
    });
    expect(result.pagination).toEqual({
      offset: 0,
      limit: 10,
      total: 12,
      hasMore: true,
      nextOffset: 10,
    });
  });

  it('keeps unread documents distinct from a completed extraction with no findings', async () => {
    const { service } = fixture(0);
    const result = await service.getRequirements('tenant-a', 'sam_gov', SOURCE_ID, AS_OF, {
      limit: 10,
    });
    expect(result.coverage).toBe('no_documents');
    expect(result.coverageExplanation).toContain('nothing has been read');
    expect(result.pagination).toMatchObject({ total: 0, hasMore: false, nextOffset: null });
  });

  it.each([{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 501 }])(
    'rejects invalid paging without reading requirements: %j',
    async (page) => {
      const { service, port } = fixture(3);
      await expect(
        service.getRequirements('tenant-a', 'sam_gov', SOURCE_ID, AS_OF, page),
      ).rejects.toThrow('pagination');
      expect(port.readRequirements).not.toHaveBeenCalled();
    },
  );
});
