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

  test('accepts the 15 actual organization identities for new clients', () => {
    expect(CLIENT_ORGANIZATION_TYPES).toHaveLength(15);
    expect(validateClientFundingProfile({ applicantTypes: CLIENT_ORGANIZATION_TYPES })).toEqual({
      applicantTypes: CLIENT_ORGANIZATION_TYPES,
    });
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
