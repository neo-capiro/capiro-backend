import { describe, expect, it } from 'vitest';
import {
  GRANTS_GOV_APPLICANT_TYPES,
  GRANTS_GOV_OTHER_APPLICANTS,
  GRANTS_GOV_UNRESTRICTED_APPLICANTS,
} from '@capiro/shared';
import type { Client } from './clientTypes.js';
import { readClientFundingPriorities, readClientRegistrations } from './client-registrations.js';

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
