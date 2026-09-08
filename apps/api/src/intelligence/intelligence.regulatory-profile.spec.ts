import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { IntelligenceService } from './intelligence.service.js';

describe('Client regulatory profile source isolation', () => {
  function setup(status = 'active') {
    const prisma: any = {
      withTenant: jest.fn(async (_tenant, fn) =>
        fn({ client: { findFirst: async () => ({ id: 'client', status }) } }),
      ),
    };
    const service = new IntelligenceService(prisma);
    const profile = jest.spyOn(service, 'getClientProfile');
    const links = jest
      .spyOn(service, 'getBillRegulationLinks')
      .mockResolvedValue({ links: [], totalBills: 0, totalRegulations: 0 });
    const relevant = jest
      .spyOn(service as any, 'getClientRelevantRegulations')
      .mockResolvedValue([]);
    return { service, prisma, profile, links, relevant };
  }
  it('loads independently of the profile spine and unrelated financial sources', async () => {
    const { service, profile, relevant } = setup();
    relevant.mockResolvedValue([
      {
        documentNumber: '2026-1',
        type: 'PROPOSED_RULE',
        title: 'Relevant rule',
        agencyNames: ['Agency'],
        publicationDate: new Date(),
        commentEndDate: new Date('2030-01-01'),
        effectiveDate: null,
        htmlUrl: 'https://www.federalregister.gov/d/2026-1',
      },
    ]);
    const result = await service.getClientRegulatoryProfile('client', 'tenant');
    expect(result.regulatoryLifecycle.rails).toHaveLength(1);
    expect(result.partial).toBe(false);
    expect(profile).not.toHaveBeenCalled();
  });
  it('reports missing coverage while keeping a successful source', async () => {
    const { service, links } = setup();
    links.mockRejectedValue(new Error('database unavailable'));
    const result = await service.getClientRegulatoryProfile('client', 'tenant');
    expect(result.partial).toBe(true);
    expect(result.sources[0]?.status).toBe('unavailable');
    expect(result.regulatoryLifecycle.rails).toEqual([]);
  });
  it('does not report a successful empty result when both sources fail', async () => {
    const { service, links, relevant } = setup();
    links.mockRejectedValue(new Error('source failed'));
    relevant.mockRejectedValue(new Error('source failed'));
    await expect(service.getClientRegulatoryProfile('client', 'tenant')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('rejects archived clients before starting source work', async () => {
    const { service, links } = setup('archived');
    await expect(service.getClientRegulatoryProfile('client', 'tenant')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(links).not.toHaveBeenCalled();
  });
});
