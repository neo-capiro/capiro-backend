import type { FedrampProductRecord } from '../external/fedramp/fedramp.client.js';

jest.mock('../external/fedramp/fedramp.client.js', () => ({
  fetchFedrampProducts: jest.fn(),
}));

import { fetchFedrampProducts } from '../external/fedramp/fedramp.client.js';
import { MeriToolsService } from './meri-tools.service.js';

const observedAt = '2026-09-23T13:27:12.000Z';
const product = (productId: string, cspName: string, csoName: string): FedrampProductRecord => ({
  productId,
  cspName,
  csoName,
  status: 'FedRAMP Certified',
  impactLevel: 'Moderate',
  authorizationDate: '2025-02-01T00:00:00.000Z',
  sponsoringAgencies: ['Department of Justice'],
  sourceUrl: 'https://fedramp.gov/marketplace/products/',
  observedAt,
});

const call = (query: string) =>
  (MeriToolsService.prototype as unknown as {
    getCertificationStatus(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  }).getCertificationStatus({ program: 'fedramp', query });

describe('get_certification_status', () => {
  beforeEach(() => jest.mocked(fetchFedrampProducts).mockReset());

  it('returns at most ten candidates and never chooses an ambiguous product', async () => {
    jest
      .mocked(fetchFedrampProducts)
      .mockResolvedValue(Array.from({ length: 12 }, (_, i) => product(`FR${i}`, 'Example CSP', `Cloud ${i}`)));
    const result = await call('Example');
    expect(result).toMatchObject({
      found: true,
      ambiguous: true,
      candidateCount: 12,
      candidates: expect.any(Array),
    });
    expect(result).not.toHaveProperty('record');
    expect(result.candidates).toHaveLength(10);
  });

  it('reports a complete-dataset miss explicitly as evidence of absence', async () => {
    jest.mocked(fetchFedrampProducts).mockResolvedValue([product('FR1', 'One CSP', 'One Cloud')]);
    await expect(call('missing')).resolves.toMatchObject({
      found: false,
      searchedEntireDataset: true,
      evidenceOfAbsence: true,
      sourceUrl: 'https://fedramp.gov/marketplace/products/',
      observedAt,
    });
  });

  it('uses an exact product id to return source strings unchanged', async () => {
    jest.mocked(fetchFedrampProducts).mockResolvedValue([product('FR1', 'One CSP', 'One Cloud')]);
    await expect(call('fr1')).resolves.toMatchObject({
      ambiguous: false,
      record: { productId: 'FR1', status: 'FedRAMP Certified', impactLevel: 'Moderate' },
    });
  });
});
