import type { FedrampProductRecord } from '../external/fedramp/fedramp.client.js';

jest.mock('../external/fedramp/fedramp.client.js', () => ({
  fetchFedrampProducts: jest.fn(),
}));

import { fetchFedrampProducts } from '../external/fedramp/fedramp.client.js';
import { withMeriReadObservation } from './meri-funding-read-observation.js';
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

const callObserved = (query: string, comparisonLocale: 'en-US' | 'tr-TR') =>
  withMeriReadObservation(
    { operationId: 'get_certification_status', comparisonLocale },
    () => call(query),
  );

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

  it('uses the observed locale for both CSP and CSO comparisons', async () => {
    jest.mocked(fetchFedrampProducts).mockResolvedValue([
      product('FR1', 'ı Partner', 'Other Cloud'),
      product('FR2', 'Other CSP', 'ı Cloud'),
      product('FR3', 'I Partner', 'I Offering'),
    ]);

    const turkish = await callObserved('I', 'tr-TR');
    expect(turkish).toMatchObject({ found: true, ambiguous: true, candidateCount: 3 });
    expect((turkish.candidates as FedrampProductRecord[]).map((record) => record.productId))
      .toEqual(['FR1', 'FR2', 'FR3']);

    const english = await callObserved('I', 'en-US');
    expect(english).toMatchObject({ found: true, ambiguous: false, record: { productId: 'FR3' } });
  });

  it('keeps exact product-ID precedence under an observed locale', async () => {
    jest.mocked(fetchFedrampProducts).mockResolvedValue([
      product('FR1', 'FR42 Holdings', 'Other Cloud'),
      product('FR42', 'Exact CSP', 'Exact Cloud'),
    ]);

    const result = await callObserved('  fr42  ', 'tr-TR');
    expect(result).toMatchObject({
      found: true,
      ambiguous: false,
      record: { productId: 'FR42', cspName: 'Exact CSP' },
    });
    expect(result).not.toHaveProperty('candidates');
  });

  it('keeps the ten-candidate window and complete-dataset count with observed casing', async () => {
    jest.mocked(fetchFedrampProducts).mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => product(`FR${index}`, `ı Partner ${index}`, `Cloud ${index}`)),
    );

    const result = await callObserved('I', 'tr-TR');
    expect(result).toMatchObject({
      found: true,
      ambiguous: true,
      searchedEntireDataset: true,
      candidateCount: 12,
    });
    expect(result).not.toHaveProperty('record');
    expect(result.candidates).toHaveLength(10);
  });

  it('retains absence provenance when the observed locale finds no product', async () => {
    jest.mocked(fetchFedrampProducts).mockResolvedValue([product('FR1', 'Blue CSP', 'Blue Cloud')]);

    await expect(callObserved('I', 'tr-TR')).resolves.toMatchObject({
      found: false,
      searchedEntireDataset: true,
      evidenceOfAbsence: true,
      sourceUrl: 'https://fedramp.gov/marketplace/products/',
      observedAt,
    });
  });

  it('refuses a different observation operation before fetching the marketplace', async () => {
    await expect(withMeriReadObservation(
      { operationId: 'search_funding_opportunities', asOf: observedAt },
      () => call('FR1'),
    )).rejects.toThrow('does not match this operation');
    expect(fetchFedrampProducts).not.toHaveBeenCalled();
  });
});
