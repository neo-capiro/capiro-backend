import { describe, expect, test } from '@jest/globals';
import { SamEntityEnrichmentService } from '../intelligence/sam-entity.service.js';
import { normalizeCage, normalizeCompanyName, normalizeUei, uniqueNames } from './vendor-name.util.js';

/**
 * Parity guard: the vendor normalizer MUST equal the client-side SAM
 * normalizer. If someone tightens or loosens one, this fails and the two are
 * reconciled deliberately rather than drifting apart.
 */
describe('normalizeCompanyName parity with SamEntityEnrichmentService.normalize', () => {
  const sam = new SamEntityEnrichmentService(
    {} as never,
    { get: (k: string) => (k === 'SAM_ENRICHMENT_ENABLED' ? true : 'KEY') } as never,
    {} as never,
  );
  const samples = [
    'RTX Corporation, Inc.',
    'Lockheed Martin Corporation',
    'A&B Co',
    'Carlyle Group',
    'Acme Widgets International',
    'THE BOEING COMPANY',
    'General Dynamics Land Systems L.L.C.',
    '  spaced   out   name  ',
    '',
  ];
  test.each(samples)('%p', (name) => {
    expect(normalizeCompanyName(name)).toBe(sam.normalize(name));
  });
});

describe('identifier normalizers', () => {
  test('UEI: 12 alphanumerics, uppercased; anything else null', () => {
    expect(normalizeUei(' km99jjbnq9m5 ')).toBe('KM99JJBNQ9M5');
    expect(normalizeUei('SHORT')).toBeNull();
    expect(normalizeUei(null)).toBeNull();
  });
  test('CAGE: 5 alphanumerics, uppercased', () => {
    expect(normalizeCage('3v1f7')).toBe('3V1F7');
    expect(normalizeCage('TOOLONG')).toBeNull();
  });
  test('uniqueNames dedupes on the normalized form and keeps first spelling', () => {
    expect(uniqueNames(['Acme Corp', 'ACME CORPORATION', null, 'Acme Aero', ''])).toEqual([
      'Acme Corp',
      'Acme Aero',
    ]);
  });
});
