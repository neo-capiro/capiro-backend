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

  it('accepts observed legacy and suffixed product IDs and regex-special Svelte variables', () => {
    const source = [
      'let $={},legacy={},suffixed={},shortId={};',
      '$.id="FR1923743650A";$.csp="Automattic, Inc.";$.cso="WordPress VIP";$.status="FedRAMP Certified";$.cert_date=null;$.impact_level="Moderate";$.agency_authorizations=[];',
      'legacy.id="F1607067912";legacy.csp="18F";legacy.cso="CG-TTS - Cloud.Gov";legacy.status="FedRAMP Certified (In Remediation)";legacy.cert_date=null;legacy.impact_level="Moderate";legacy.agency_authorizations=[];',
      'suffixed.id="FR2409863458XL";suffixed.csp="Confluent";suffixed.cso="Confluent Cloud for Government";suffixed.status="FedRAMP Certified";suffixed.cert_date=null;suffixed.impact_level="Moderate";suffixed.agency_authorizations=[];',
      'shortId.id="FR260215856";shortId.csp="SandboxAQ";shortId.cso="AQtive Guard";shortId.status="Legacy FedRAMP Ready";shortId.cert_date=null;shortId.impact_level="Moderate";shortId.agency_authorizations=[];',
    ].join('\n');

    const records = parseFedrampMarketplaceProducts(source, OBSERVED);
    expect(records.map(({ productId, status }) => [productId, status])).toEqual([
      ['FR1923743650A', 'FedRAMP Certified'],
      ['F1607067912', 'FedRAMP Certified (In Remediation)'],
      ['FR2409863458XL', 'FedRAMP Certified'],
      ['FR260215856', 'Legacy FedRAMP Ready'],
    ]);
  });

  it('fails closed for an unseen product ID shape or status instead of truncating inventory', () => {
    const valid = 'a.id="FR1234567890";a.csp="Acme";a.cso="Acme Cloud";a.status="FedRAMP Certified";a.impact_level="Moderate";';
    expect(() => parseFedrampMarketplaceProducts(
      `${valid}b.id="FR1234567890Z";b.csp="Beta";b.cso="Beta Cloud";b.status="FedRAMP Certified";b.impact_level="Moderate";`,
      OBSERVED,
    )).toThrow('Unsupported marketplace product ID shape');
    expect(() => parseFedrampMarketplaceProducts(
      'a.id="FR1234567890";a.csp="Acme";a.cso="Acme Cloud";a.status="New Status";a.impact_level="Moderate";',
      OBSERVED,
    )).toThrow('Unknown marketplace status');
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

  it('retries one HTTP 200 payload that cannot be parsed, then returns the complete inventory', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response('<html/>', { status: 200 }))
      .mockResolvedValueOnce(response());
    const records = await fetchFedrampProducts({ fetchImpl, now: () => new Date(OBSERVED) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(4);
    expect(records[0]!.observedAt).toBe(OBSERVED);
  });

  it('fails closed after two HTTP 200 payloads with no complete records', async () => {
    const fetchImpl = jest.fn().mockImplementation(async () => new Response('<html/>', { status: 200 }));
    await expect(fetchFedrampProducts({ fetchImpl })).rejects.toThrow(
      'No FedRAMP product records found',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx response once', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response());
    const records = await fetchFedrampProducts({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(4);
  });

  it('does not retry 4xx responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(404));
    await expect(fetchFedrampProducts({ fetchImpl })).rejects.toBeInstanceOf(FedrampMarketplaceError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
