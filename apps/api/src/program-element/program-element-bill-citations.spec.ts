import { ProgramElementReadService } from './program-element-read.service.js';

describe('PE bill public citations', () => {
  it.each([
    ['119-s-2809', 'https://www.congress.gov/bill/119th-congress/senate-bill/2809'],
    ['118-hr-1', 'https://www.congress.gov/bill/118th-congress/house-bill/1'],
    ['119-hjres-2', 'https://www.congress.gov/bill/119th-congress/house-joint-resolution/2'],
    ['1-s-1', 'https://www.congress.gov/bill/1st-congress/senate-bill/1'],
    ['009-s-00001', 'https://www.congress.gov/bill/9th-congress/senate-bill/1'],
    ['00-s-1', 'https://api.congress.gov/v3/bill/00/s/1?format=json'],
    ['119-s-0', 'https://api.congress.gov/v3/bill/119/s/0?format=json'],
  ])('projects only a valid public bill identity for %s without changing stored evidence', async (id, url) => {
    const [congress, billType, billNumber] = id.split('-');
    const stored = Object.freeze({ id, congress: Number(congress), billType, billNumber,
      title: 'Synthetic bill', url: `https://api.congress.gov/v3/bill/${congress}/${billType}/${billNumber}?format=json`,
      latestActionDate: null, sponsorName: 'Synthetic sponsor', committeeRefs: [{ committeeName: 'Synthetic committee' }],
      peCodes: ['0600001A'], policyArea: null, latestActionText: null });
    const service = Object.create(ProgramElementReadService.prototype) as ProgramElementReadService;
    Object.assign(service, { getVersionedFederalBillIds: async () => [], prisma: {
      programElement: { findUnique: async () => ({ peCode: '0600001A' }) },
      congressBill: { findMany: async () => [stored] },
      billBudgetLineLink: { findMany: async () => [{ billId: id, linkType: 'explicit', confidence: 1, evidence: 'Synthetic evidence', status: 'accepted' }] },
      budgetPackageVehicle: { findMany: async () => [] }, $queryRaw: async () => [],
    } });
    const [row] = await service.getBills('0600001A');
    expect(row).toMatchObject({ id, url,
      sponsor: 'Synthetic sponsor', committee: 'Synthetic committee', peCodeCount: 1,
      link: { type: 'explicit', evidence: 'Synthetic evidence', status: 'accepted' }, budgetPackage: null });
    expect(stored.url).toContain('api.congress.gov');
  });
});
