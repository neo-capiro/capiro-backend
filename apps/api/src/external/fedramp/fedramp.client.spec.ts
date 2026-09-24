import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FEDRAMP_MARKETPLACE_URL,
  FedrampMarketplaceError,
  fetchFedrampProducts,
  parseFedrampMarketplaceProducts,
} from './fedramp.client.js';

const FIXTURE = readFileSync(
  join(__dirname, '__fixtures__', 'marketplace-products.fixture.html'),
  'utf8',
);
const OBSERVED = '2026-09-23T13:27:12.000Z';

describe('FedRAMP marketplace parser', () => {
  it('preserves exact official status/impact strings and structured provenance', () => {
    const records = parseFedrampMarketplaceProducts(FIXTURE, OBSERVED);
    expect(records).toHaveLength(4);
    expect(records[0]).toEqual({
      productId: 'FR2335047392',
      cspName: '3rd Eye Technologies LLC.',
      csoName: 'Mystic Message Archival',
      status: 'FedRAMP Certified',
      impactLevel: 'Moderate',
      authorizationDate: '2025-01-31T20:00:00.000Z',
      sponsoringAgencies: [
        'Cybersecurity & Infrastructure Security Agency',
        'Department of Justice',
        'United States Marshals Service',
      ],
      sourceUrl: FEDRAMP_MARKETPLACE_URL,
      observedAt: OBSERVED,
    });
    expect(records.map((record) => record.status)).toEqual([
      'FedRAMP Certified',
      'Agency Authorization In Process',
      'Legacy FedRAMP Ready',
      'Initial Implementation',
    ]);
    expect(records[1]!.sponsoringAgencies).toEqual([]);
  });

  it('fails closed when the source structure no longer contains complete records', () => {
    expect(() => parseFedrampMarketplaceProducts('<html/>', OBSERVED)).toThrow(
      'No FedRAMP product records found',
    );
  });
});

describe('FedRAMP marketplace client', () => {
  const response = (status = 200) => new Response(FIXTURE, { status });

  it('retries one transient failure and timestamps the observation', async () => {
    const fetchImpl = jest.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(response());
    const records = await fetchFedrampProducts({
      fetchImpl,
      now: () => new Date(OBSERVED),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(records[0]!.observedAt).toBe(OBSERVED);
  });

  it('does not retry 4xx responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(404));
    await expect(fetchFedrampProducts({ fetchImpl })).rejects.toBeInstanceOf(FedrampMarketplaceError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
