import { SourceRegistryService } from './source-registry.service.js';
import { CommitteeSourceRepository } from './committee-source.repository.js';

describe('federal and Florida committee publication registration', () => {
  it('keeps state sources explicitly namespaced and prefers verified directory pages over meeting notices', async () => {
    const ensureSource = jest.fn().mockResolvedValue({});
    const prisma = {
      congressCommittee: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              systemCode: 'hsas00',
              name: 'Armed Services',
              chamber: 'house',
              url: 'https://armedservices.house.gov/',
            },
          ]),
      },
      stateCommittee: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'fl-commerce',
            name: 'Commerce Committee',
            chamber: 'lower',
            sourceUrl: 'https://www.flhouse.gov/meetingnotice.aspx?id=1',
            sourceEvidence: {
              directory: {
                active: true,
                sourceUrl:
                  'https://www.flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=1',
              },
            },
          },
          {
            id: 'fl-retired',
            name: 'Old Committee',
            chamber: 'upper',
            sourceUrl: 'https://www.flsenate.gov/old',
            sourceEvidence: { directory: { active: false } },
          },
          {
            id: 'fl-other-host',
            name: 'Bad Source',
            chamber: 'upper',
            sourceUrl: 'https://example.com/',
            sourceEvidence: {},
          },
        ]),
      },
    };
    const result = await new SourceRegistryService(
      prisma as never,
      { ensureSource } as never,
    ).ensureCommitteeSiteSources();
    expect(result.registered).toBe(2);
    expect(ensureSource.mock.calls[1]?.[0]).toMatchObject({
      committeeSystemCode: 'state:FL:fl-commerce',
      chamber: 'house',
      sourceUrl: 'https://www.flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=1',
    });
    expect(prisma.congressCommittee.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { isCurrent: true, parentSystemCode: null },
    });
    expect(prisma.stateCommittee.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { state: 'FL', officialSourceKey: { not: null } },
    });
  });
  it('orders bounded update work by oldest check, without changing ordinary priority selection', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const repo = new CommitteeSourceRepository({ committeeSource: { findMany } } as never);
    await repo.listEnabled({ adapterKey: 'committee-site', oldestCheckedFirst: true });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { sourceUrl: 'asc' }],
    });
    await repo.listEnabled();
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      orderBy: [{ priority: 'asc' }, { sourceUrl: 'asc' }],
    });
  });
});
