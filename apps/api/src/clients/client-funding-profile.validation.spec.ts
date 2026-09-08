import { BadRequestException } from '@nestjs/common';
import {
  GRANTS_GOV_APPLICANT_TYPES,
  GRANTS_GOV_OTHER_APPLICANTS,
  GRANTS_GOV_UNRESTRICTED_APPLICANTS,
  MAX_FUNDING_PRIORITIES,
  MAX_FUNDING_PRIORITY_LENGTH,
} from '@capiro/shared';
import {
  CLIENT_ORGANIZATION_TYPES,
  validateClientFundingProfile,
} from './client-funding-profile.validation.js';

describe('client funding profile write validation', () => {
  const smallBusiness = GRANTS_GOV_APPLICANT_TYPES[13];

  test('accepts each of the 15 actual organization identities for new clients', () => {
    expect(CLIENT_ORGANIZATION_TYPES).toHaveLength(15);
    for (const type of CLIENT_ORGANIZATION_TYPES) expect(validateClientFundingProfile({ applicantTypes: [type] })).toEqual({ applicantTypes: [type] });
  });

  test.each([
    GRANTS_GOV_OTHER_APPLICANTS,
    GRANTS_GOV_UNRESTRICTED_APPLICANTS,
    'Unknown legacy organization',
  ])('rejects a new non-identity label: %s', (label) => {
    expect(() => validateClientFundingProfile({ applicantTypes: [label] })).toThrow(
      BadRequestException,
    );
    expect(() =>
      validateClientFundingProfile(
        { applicantTypes: [label] },
        { applicantTypes: [smallBusiness] },
      ),
    ).toThrow(BadRequestException);
  });

  test.each([
    GRANTS_GOV_OTHER_APPLICANTS,
    GRANTS_GOV_UNRESTRICTED_APPLICANTS,
    'Unknown legacy organization',
  ])('preserves an exact existing legacy label while allowing valid edits: %s', (label) => {
    const existing = { applicantTypes: [label] };
    expect(
      validateClientFundingProfile({ applicantTypes: [label, smallBusiness] }, existing),
    ).toEqual({ applicantTypes: [label, smallBusiness] });
    expect(validateClientFundingProfile({ applicantTypes: [smallBusiness] }, existing)).toEqual({
      applicantTypes: [smallBusiness],
    });
    expect(validateClientFundingProfile({}, existing)).toEqual({});
  });

  test('canonicalizes real organization labels and removes duplicates', () => {
    expect(
      validateClientFundingProfile({ applicantTypes: ['  SMALL   BUSINESSES ', smallBusiness] }),
    ).toEqual({ applicantTypes: [smallBusiness] });
  });

  test('does not let a legacy label be disguised as a different new label', () => {
    expect(() =>
      validateClientFundingProfile(
        { applicantTypes: ['unknown legacy'] },
        { applicantTypes: ['Unknown legacy'] },
      ),
    ).toThrow(BadRequestException);
  });

  test.each([42, {}, 'Small businesses', [42]])(
    'rejects malformed organization input %p',
    (value) => {
      expect(() => validateClientFundingProfile({ applicantTypes: value } as never)).toThrow(
        BadRequestException,
      );
    },
  );

  test('normalizes explicit priorities and preserves supplied unrelated intake fields', () => {
    const input = {
      intakeData: {
        custom: { retained: true },
        fundingAsk: 'existing ask',
        fundingPriorities: [
          '  Ground   vehicle demonstrations ',
          'ground vehicle demonstrations',
          'Remote sensing trials',
        ],
      },
    };
    expect(validateClientFundingProfile(input)).toEqual({
      intakeData: {
        custom: { retained: true },
        fundingAsk: 'existing ask',
        fundingPriorities: ['Ground vehicle demonstrations', 'Remote sensing trials'],
      },
    });
    expect(input.intakeData.fundingPriorities).toHaveLength(3);
  });

  test('retains the intake replacement contract, including explicit clear', () => {
    expect(validateClientFundingProfile({ intakeData: {} })).toEqual({ intakeData: {} });
    expect(validateClientFundingProfile({ intakeData: { fundingPriorities: [] } })).toEqual({
      intakeData: { fundingPriorities: [] },
    });
    expect(
      validateClientFundingProfile({ intakeData: null, applicantTypes: null } as never),
    ).toEqual({ intakeData: {}, applicantTypes: [] });
  });

  test.each([
    null,
    'robotics',
    {},
    [42],
    [''],
    ['   '],
    ['x'.repeat(MAX_FUNDING_PRIORITY_LENGTH + 1)],
    Array.from({ length: MAX_FUNDING_PRIORITIES + 1 }, () => 'robotics'),
  ])('rejects malformed or oversized priorities without silently truncating: %p', (value) => {
    expect(() =>
      validateClientFundingProfile({ intakeData: { fundingPriorities: value } }),
    ).toThrow(BadRequestException);
  });

  test('accepts values at both priority bounds', () => {
    const fundingPriorities = Array.from({ length: MAX_FUNDING_PRIORITIES }, (_, index) =>
      `${index}`.padEnd(MAX_FUNDING_PRIORITY_LENGTH, 'x'),
    );
    expect(validateClientFundingProfile({ intakeData: { fundingPriorities } })).toEqual({
      intakeData: { fundingPriorities },
    });
  });
});

describe('registration integrity on canonical writes', () => {
  const nonprofit = GRANTS_GOV_APPLICANT_TYPES[1];
  const conflicting = [nonprofit, GRANTS_GOV_APPLICANT_TYPES[9]];
  test.each([conflicting, [GRANTS_GOV_APPLICANT_TYPES[4], GRANTS_GOV_APPLICANT_TYPES[5]], [nonprofit, GRANTS_GOV_APPLICANT_TYPES[13]]].map((applicantTypes) => ({ applicantTypes })))('rejects a new incompatible entity combination $applicantTypes', ({ applicantTypes }) => {
    expect(() => validateClientFundingProfile({ applicantTypes })).toThrow(BadRequestException);
  });
  test('allows unrelated edits or removing conflicts from existing records', () => {
    expect(validateClientFundingProfile({ applicantTypes: conflicting, intakeData: { note: 'updated' } }, { applicantTypes: conflicting })).toEqual({ applicantTypes: conflicting, intakeData: { note: 'updated' } });
    expect(validateClientFundingProfile({ applicantTypes: [nonprofit] }, { applicantTypes: conflicting })).toEqual({ applicantTypes: [nonprofit] });
  });
  test('permits legitimate overlapping classifications, including NAICS-dependent size and tribal/nonprofit status', () => {
    for (const applicantTypes of [[GRANTS_GOV_APPLICANT_TYPES[12], GRANTS_GOV_APPLICANT_TYPES[13]], [nonprofit, GRANTS_GOV_APPLICANT_TYPES[6]]]) {
      expect(validateClientFundingProfile({ applicantTypes })).toEqual({ applicantTypes });
    }
  });
  test('keeps cross-field nonprofit/business ambiguity reviewable instead of rejecting unverified affiliate facts', () => {
    const input = { applicantTypes: [nonprofit], intakeData: { sbClassification: { sb: true } }, setAsideCertifications: ['8A'] };
    expect(validateClientFundingProfile(input)).toEqual({ applicantTypes: [nonprofit], intakeData: input.intakeData });
  });
  test.each(['12-3456789', '123456789', ' 12-3456789 '])('normalizes EIN %s', (ein) => {
    expect(validateClientFundingProfile({ intakeData: { ein } })).toEqual({ intakeData: { ein: '123456789' } });
  });
  test.each(['123456', '12-34567890', 'AB-3456789', '1-23456789', 123456789])('rejects new invalid EIN %p', (ein) => {
    expect(() => validateClientFundingProfile({ intakeData: { ein } })).toThrow(BadRequestException);
  });
  test('permits explicit clearing or preserving an unchanged invalid saved EIN while editing other fields', () => {
    const existing = { intakeData: { ein: '123456' } };
    expect(validateClientFundingProfile({ intakeData: { ein: '123456', note: 'updated' } }, existing)).toEqual({ intakeData: { ein: '123456', note: 'updated' } });
    expect(validateClientFundingProfile({ intakeData: { ein: '' } }, existing)).toEqual({ intakeData: {} });
    expect(() => validateClientFundingProfile({ intakeData: { ein: '654321' } }, existing)).toThrow(BadRequestException);
  });
  test('reconciles a canonical-only NAICS update without clearing unrelated intake or inventing a primary', () => {
    const existing = { intakeData: { primaryNaics: '541330', additionalNaics: '541512', note: 'retain' } };
    expect(validateClientFundingProfile({ naicsCodes: ['336414'] }, existing)).toEqual({ naicsCodes: ['336414'], intakeData: { note: 'retain' } });
    expect(validateClientFundingProfile({ naicsCodes: ['541330', '336414'] }, existing)).toEqual({ naicsCodes: ['541330', '336414'], intakeData: { primaryNaics: '541330', additionalNaics: '336414', note: 'retain' } });
  });
});
