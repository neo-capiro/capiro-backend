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

  // ── Set-aside certifications: durable new codes, preserved legacy stored codes ──
  describe('set-aside certifications', () => {
    test.each(['8A', 'SDVOSB', 'VOSB', 'WOSB', 'EDWOSB', 'HUBZONE'])(
      'accepts each durable certification as a new selection: %s',
      (code) => {
        expect(validateClientFundingProfile({ setAsideCertifications: [code] })).toEqual({
          setAsideCertifications: [code],
        });
      },
    );

    test.each(['SDVOSBC', 'HZC', 'SBA', 'SBP', '8AN', 'WOSBSS', 'EDWOSBSS', 'HZS', 'NOTACODE'])(
      'rejects a legacy restriction/sole-source or invalid code as a NEW selection: %s',
      (code) => {
        expect(() => validateClientFundingProfile({ setAsideCertifications: [code] })).toThrow(
          BadRequestException,
        );
        // Even alongside a valid durable code, an unrecognized new value is refused.
        expect(() =>
          validateClientFundingProfile({ setAsideCertifications: ['8A', code] }),
        ).toThrow(BadRequestException);
      },
    );

    test.each(['SDVOSBC', 'HZC', 'SBA'])(
      'preserves an exact stored legacy code while allowing durable edits and removals: %s',
      (legacy) => {
        const existing = { setAsideCertifications: [legacy] };
        // Unchanged historical value round-trips so an unrelated save does not fail.
        expect(
          validateClientFundingProfile({ setAsideCertifications: [legacy] }, existing),
        ).toEqual({ setAsideCertifications: [legacy] });
        // A legacy value plus a valid new durable selection both survive.
        expect(
          validateClientFundingProfile({ setAsideCertifications: [legacy, '8A'] }, existing),
        ).toEqual({ setAsideCertifications: [legacy, '8A'] });
        // Removing the legacy value (clearing) is allowed.
        expect(validateClientFundingProfile({ setAsideCertifications: ['8A'] }, existing)).toEqual({
          setAsideCertifications: ['8A'],
        });
        expect(validateClientFundingProfile({ setAsideCertifications: [] }, existing)).toEqual({
          setAsideCertifications: [],
        });
        // Omitting the field entirely leaves it untouched.
        expect(validateClientFundingProfile({}, existing)).toEqual({});
      },
    );

    test('does not let a legacy stored code be re-claimed under a different client that never held it', () => {
      // 'SDVOSBC' stored on THIS client may persist; it may NOT be introduced onto
      // a client whose stored set is different (the preserve set is per-client).
      expect(() =>
        validateClientFundingProfile(
          { setAsideCertifications: ['SDVOSBC'] },
          { setAsideCertifications: ['8A'] },
        ),
      ).toThrow(BadRequestException);
    });

    test('removes duplicate codes and rejects non-string entries', () => {
      expect(
        validateClientFundingProfile({ setAsideCertifications: ['8A', '8A', 'WOSB'] }),
      ).toEqual({ setAsideCertifications: ['8A', 'WOSB'] });
      expect(() =>
        validateClientFundingProfile({ setAsideCertifications: [42] } as never),
      ).toThrow(BadRequestException);
      expect(() =>
        validateClientFundingProfile({ setAsideCertifications: 'SDVOSB' } as never),
      ).toThrow(BadRequestException);
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
    expect(validateClientFundingProfile(input)).toEqual({ applicantTypes: [nonprofit], intakeData: input.intakeData, setAsideCertifications: ['8A'] });
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
