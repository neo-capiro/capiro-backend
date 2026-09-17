import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { parseSamEntity, SAM_ENTITY_URL, VendorReferenceSamClient } from './vendor-reference-sam.client.js';

function makeClient(apiKey?: string, enabled = true) {
  // A default PARAMETER value kicks in for an explicitly-passed `undefined`
  // too (JS semantics), so `makeClient(undefined)` — the "no api key" case —
  // would silently fall back to 'TESTKEY' with a plain default. `arguments`
  // distinguishes "no argument given" (every other call site, wants the
  // default) from "called with undefined" (the no_api_key test, wants it).
  const resolvedApiKey = arguments.length >= 1 ? apiKey : 'TESTKEY';
  const config = {
    get: (k: string) => (k === 'SAM_ENRICHMENT_ENABLED' ? enabled : resolvedApiKey),
  } as never;
  return new VendorReferenceSamClient(config);
}

function samRow(over: Record<string, unknown> = {}) {
  return {
    entityRegistration: {
      ueiSAM: 'KM99JJBNQ9M5',
      cageCode: '3V1F7',
      legalBusinessName: 'LOCKHEED MARTIN CORPORATION',
      dbaName: null,
      registrationStatus: 'Active',
      registrationDate: '2024-01-15',
      registrationExpirationDate: '2027-01-15',
      lastUpdateDate: '2026-06-01',
      ...((over.entityRegistration as object) ?? {}),
    },
    coreData: {
      congressionalDistrict: '8',
      physicalAddress: {
        addressLine1: '6801 ROCKLEDGE DR',
        city: 'BETHESDA',
        stateOrProvinceCode: 'md',
        zipCode: '20817',
        countryCode: 'USA',
      },
      generalInformation: { entityStructureDesc: 'Corporate Entity (Not Tax Exempt)', stateOfIncorporationCode: 'MD' },
      ...((over.coreData as object) ?? {}),
    },
    assertions: {
      goodsAndServices: {
        primaryNaics: '336411',
        naicsList: [{ naicsCode: '336411' }, { naicsCode: '541330' }],
        pscList: [{ pscCode: '1510' }, { pscCode: null }],
      },
    },
  };
}

type FetchCall = { url: string; init: { headers: Record<string, string> } };

function mockFetch(payload: unknown, ok = true, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  (global as { fetch?: unknown }).fetch = jest.fn(async (url: string, init: FetchCall['init']) => {
    calls.push({ url, init });
    return { ok, status, json: async () => payload };
  }) as never;
  return { calls };
}

afterEach(() => {
  delete (global as { fetch?: unknown }).fetch;
});

describe('VendorReferenceSamClient', () => {
  test('lookupByUei sends ueiSAM as a query param and the key as a HEADER', async () => {
    const { calls } = mockFetch({ entityData: [samRow()] });
    const res = await makeClient().lookupByUei('km99jjbnq9m5');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entities).toHaveLength(1);
      expect(res.entities[0]!.uei).toBe('KM99JJBNQ9M5');
    }
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(SAM_ENTITY_URL);
    expect(url.searchParams.get('ueiSAM')).toBe('KM99JJBNQ9M5');
    expect(url.searchParams.get('api_key')).toBeNull();
    expect(calls[0]!.init.headers['X-Api-Key']).toBe('TESTKEY');
  });

  test('lookupByCage / lookupByName use their own params', async () => {
    const { calls } = mockFetch({ entityData: [] });
    await makeClient().lookupByCage('3v1f7');
    await makeClient().lookupByName('Lockheed Martin');
    expect(new URL(calls[0]!.url).searchParams.get('cageCode')).toBe('3V1F7');
    expect(new URL(calls[1]!.url).searchParams.get('legalBusinessName')).toBe('Lockheed Martin');
  });

  test('bad identifiers never reach the network', async () => {
    const { calls } = mockFetch({ entityData: [] });
    expect((await makeClient().lookupByUei('nope')).ok).toBe(false);
    expect((await makeClient().lookupByCage('toolong')).ok).toBe(false);
    expect((await makeClient().lookupByName('ab')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('no api key → ok:false reason no_api_key, no fetch', async () => {
    const { calls } = mockFetch({ entityData: [] });
    const res = await makeClient(undefined).lookupByUei('KM99JJBNQ9M5');
    expect(res).toEqual(expect.objectContaining({ ok: false, reason: 'no_api_key' }));
    expect(calls).toHaveLength(0);
  });

  test('kill-switch → reason disabled', async () => {
    const res = await makeClient('KEY', false).lookupByUei('KM99JJBNQ9M5');
    expect(res).toEqual(expect.objectContaining({ ok: false, reason: 'disabled' }));
  });

  test('HTTP error → ok:false http_error (never throws)', async () => {
    mockFetch({}, false, 429);
    const res = await makeClient().lookupByUei('KM99JJBNQ9M5');
    expect(res).toEqual(expect.objectContaining({ ok: false, reason: 'http_error' }));
  });

  test('network failure → ok:false network_error (never throws)', async () => {
    (global as { fetch?: unknown }).fetch = jest.fn(async () => {
      throw new Error('ECONNRESET');
    }) as never;
    const res = await makeClient().lookupByUei('KM99JJBNQ9M5');
    expect(res).toEqual(expect.objectContaining({ ok: false, reason: 'network_error' }));
  });
});

describe('parseSamEntity', () => {
  test('maps the full record the dossier needs', () => {
    const e = parseSamEntity(samRow());
    expect(e).toEqual(
      expect.objectContaining({
        uei: 'KM99JJBNQ9M5',
        cageCode: '3V1F7',
        legalBusinessName: 'LOCKHEED MARTIN CORPORATION',
        registrationStatus: 'Active',
        registrationExpirationDate: '2027-01-15',
        congressionalDistrict: '08',
        entityStructure: 'Corporate Entity (Not Tax Exempt)',
        stateOfIncorporation: 'MD',
        primaryNaics: '336411',
        naicsCodes: ['336411', '541330'],
        pscCodes: ['1510'],
      }),
    );
    expect(e!.physicalAddress).toEqual({
      line1: '6801 ROCKLEDGE DR',
      line2: null,
      city: 'BETHESDA',
      state: 'MD',
      zip: '20817',
      country: 'USA',
    });
  });

  test('rows without a valid UEI or legal name are dropped', () => {
    expect(parseSamEntity(samRow({ entityRegistration: { ueiSAM: 'BAD' } }))).toBeNull();
    expect(parseSamEntity(samRow({ entityRegistration: { legalBusinessName: '' } }))).toBeNull();
    expect(parseSamEntity(null)).toBeNull();
  });

  test('missing sections degrade to nulls, not throws', () => {
    const e = parseSamEntity({ entityRegistration: { ueiSAM: 'ABCDEFGHJKLM', legalBusinessName: 'X CORP' } });
    expect(e).toEqual(
      expect.objectContaining({ physicalAddress: null, cageCode: null, naicsCodes: [], pscCodes: [] }),
    );
  });
});
