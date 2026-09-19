import { describe, expect, it } from 'vitest';
import {
  GRANTS_GOV_APPLICANT_TYPES,
  GRANTS_GOV_OTHER_APPLICANTS,
  GRANTS_GOV_UNRESTRICTED_APPLICANTS,
} from '@capiro/shared';
import type { Client } from './clientTypes.js';
import { readClientFundingPriorities, readClientRegistrations, SET_ASIDE_CERTIFICATION_OPTIONS, setAsideLabel } from './client-registrations.js';

function client(fields: Partial<Client> = {}): Client {
  return { id: 'client-display', name: 'Harbor Institute', ...fields } as Client;
}

describe('client organization display', () => {
  it('keeps public/private education and nonprofit tax-status distinctions in short labels', () => {
    const { rows } = readClientRegistrations(
      client({
        applicantTypes: [
          GRANTS_GOV_APPLICANT_TYPES[4],
          GRANTS_GOV_APPLICANT_TYPES[5],
          GRANTS_GOV_APPLICANT_TYPES[1],
          GRANTS_GOV_APPLICANT_TYPES[9],
        ],
      }),
    );
    expect(rows).toContainEqual({
      label: 'Organization types',
      value:
        'Nonprofit with 501(c)(3) status · Nonprofit without 501(c)(3) status · Public college or university · Private college or university',
    });
    expect(rows.some((row) => row.label.includes('Eligible'))).toBe(false);
  });

  it('separates saved source rules and unknown values for review without hiding or changing them', () => {
    const record = client({
      applicantTypes: [
        GRANTS_GOV_APPLICANT_TYPES[13],
        '  SMALL BUSINESSES  ',
        GRANTS_GOV_UNRESTRICTED_APPLICANTS,
        GRANTS_GOV_OTHER_APPLICANTS,
        'Regional consortium',
      ],
    });
    const before = structuredClone(record);
    const { rows } = readClientRegistrations(record);
    expect(rows).toContainEqual({ label: 'Organization types', value: 'Small business' });
    expect(rows).toContainEqual({
      label: 'Organization types — review needed',
      value:
        'Unrestricted (opportunity rule) · Other (requires source eligibility review) · Regional consortium',
    });
    expect(record).toEqual(before);
  });

  it('never represents source-only saved values as an organization identity', () => {
    const { rows } = readClientRegistrations(
      client({ applicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS] }),
    );
    expect(rows.find((row) => row.label === 'Organization types')).toBeUndefined();
    expect(rows.find((row) => row.label === 'Organization types — review needed')).toBeDefined();
  });
});

describe('registration accuracy', () => {
  it('shows every generic legacy NAICS identifier without assigning a primary', () => {
    const { rows } = readClientRegistrations(client({ intakeData: { naics: '541330, 541512' } }));
    expect(rows).toContainEqual({ label: 'NAICS codes', value: '541330, 541512' });
    expect(rows.some((row) => row.label === 'Primary NAICS')).toBe(false);
  });

  it.each([
    { intakeData: { sbClassification: { sb: true } } },
    { intakeData: { sbClassification: { large: true } } },
    { intakeData: { sbClassification: { wosb: true } } },
    { setAsideCertifications: ['8A'] },
  ])('surfaces nonprofit/business facts stored outside organization types for review: %j', (fields) => {
    const saved = client({ applicantTypes: [GRANTS_GOV_APPLICANT_TYPES[1]], ...fields });
    const before = structuredClone(saved);
    const { rows } = readClientRegistrations(saved);
    expect(rows.find((row) => row.label === 'Registration — review needed')?.value).toContain('A nonprofit organization type and business classifications or set-aside certifications');
    expect(saved).toEqual(before);
  });

  it('uses the same canonical codes as editing and matching, without guessing a primary', () => {
    const { rows } = readClientRegistrations(client({ naicsCodes: ['336414'], intakeData: { primaryNaics: '541330', additionalNaics: '541512' } } as Partial<Client>));
    expect(rows).toContainEqual({ label: 'NAICS codes', value: '336414' });
    expect(rows.some((row) => row.label === 'Primary NAICS')).toBe(false);
    expect(rows.some((row) => row.label === 'NAICS — review needed')).toBe(true);
  });
  it('keeps a recorded primary only when it belongs to the canonical list', () => {
    const { rows } = readClientRegistrations(client({ naicsCodes: ['541330', '336414'], intakeData: { primaryNaics: '541330', additionalNaics: '541512' } } as Partial<Client>));
    expect(rows).toContainEqual({ label: 'Primary NAICS', value: '541330' });
    expect(rows).toContainEqual({ label: 'Additional NAICS', value: '336414' });
  });
  it('does not resurrect cleared codes from legacy intake', () => {
    const { rows } = readClientRegistrations(client({ naicsCodes: [], intakeData: { primaryNaics: '541330' } } as Partial<Client>));
    expect(rows.some((row) => row.label === 'Primary NAICS' || row.label === 'NAICS codes')).toBe(false);
  });
  it('flags invalid EIN and saved identity contradictions without changing stored facts', () => {
    const saved = client({ applicantTypes: [GRANTS_GOV_APPLICANT_TYPES[13], GRANTS_GOV_APPLICANT_TYPES[1]], intakeData: { ein: '123456', sbClassification: { large: true } } } as Partial<Client>);
    const before = structuredClone(saved);
    const { rows } = readClientRegistrations(saved);
    expect(rows).toContainEqual({ label: 'EIN', value: '123456' });
    expect(rows.some((row) => row.label === 'EIN — review needed')).toBe(true);
    expect(rows.find((row) => row.label === 'Registration — review needed')?.value).toContain('For-profit and nonprofit');
    expect(rows.find((row) => row.label === 'Registration — review needed')?.value).toContain('Small and large business');
    expect(saved).toEqual(before);
  });
});

describe('set-aside certification options (D9)', () => {
  // The canonical durable-certification set the API accepts
  // (apps/api/src/funding-opportunities/set-aside.ts DURABLE_SET_ASIDE_CERTIFICATIONS,
  // enforced by the update DTO's @IsIn). The offered options must align exactly.
  const API_DURABLE_CODES = ['8A', 'SDVOSB', 'VOSB', 'WOSB', 'EDWOSB', 'HUBZONE'];

  it('offers exactly the canonical durable certifications the API accepts', () => {
    expect(SET_ASIDE_CERTIFICATION_OPTIONS.map((o) => o.value)).toEqual(API_DURABLE_CODES);
  });

  it('never offers solicitation restriction codes as certifications', () => {
    const offered = new Set(SET_ASIDE_CERTIFICATION_OPTIONS.map((o) => o.value));
    for (const restriction of ['SBA', 'SBP', '8AN', 'SDVOSBC', 'SDVOSBS', 'WOSBSS', 'EDWOSBSS', 'HZC', 'HZS']) {
      expect(offered.has(restriction)).toBe(false);
    }
  });

  it('labels durable codes directly and stored legacy codes honestly without inventing them', () => {
    expect(setAsideLabel('8A')).toBe('8(a) Business Development');
    expect(setAsideLabel('HUBZONE')).toBe('HUBZone');
    // Legacy restriction codes already persisted on older records render as
    // English (legacy-tagged), not raw codes — and are NOT certifications.
    expect(setAsideLabel('SDVOSBC')).toBe('Service-disabled veteran-owned small business (legacy)');
    expect(setAsideLabel('HZC')).toBe('HUBZone (legacy)');
    expect(setAsideLabel('SBA')).toBe('Total small business set-aside (legacy)');
    // An unrecognized code is shown as-is, never dropped.
    expect(setAsideLabel('SOMETHINGELSE')).toBe('SOMETHINGELSE');
  });
});

describe('client funding priority display', () => {
  it('reads explicit priorities separately from broad sector and focus tags', () => {
    expect(
      readClientFundingPriorities(
        client({
          intakeData: {
            fundingPriorities: [
              ' Grid-scale storage demonstration ',
              'grid-scale storage demonstration',
              '',
              'Water treatment pilot',
              17,
            ],
            sectors: ['ENERGY'],
            tags: ['Broad focus'],
          } as unknown as Client['intakeData'],
        }),
      ),
    ).toEqual(['Grid-scale storage demonstration', 'Water treatment pilot']);
  });

  it('treats absent or malformed saved priorities as unrecorded', () => {
    expect(readClientFundingPriorities(client())).toEqual([]);
    expect(
      readClientFundingPriorities(
        client({ intakeData: { fundingPriorities: 'Energy' } as unknown as Client['intakeData'] }),
      ),
    ).toEqual([]);
  });
});
