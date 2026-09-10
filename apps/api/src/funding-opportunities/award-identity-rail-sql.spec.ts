import { Prisma } from '@prisma/client';
import type { AwardIdentityRail } from './award-history-identity.js';
import { awardIdentityRailSql } from './award-identity-rail-sql.js';

function rail(overrides: Partial<AwardIdentityRail>): AwardIdentityRail {
  return {
    basis: 'none',
    ueis: [],
    fallbackNames: [],
    notes: [],
    ...overrides,
  };
}

describe('awardIdentityRailSql', () => {
  it('uses only verified UEIs when the rail is exact_uei (L3Harris canary regression)', () => {
    const predicate = awardIdentityRailSql(
      rail({
        basis: 'exact_uei',
        ueis: ['QM4EZDV15JL8'],
        // Names remain on the rail notes path in production; they must not
        // enter the predicate when a verified UEI is present.
        fallbackNames: [],
      }),
    )!;
    expect(predicate.text).toBe('recipient_uei = ANY($1::text[])');
    expect(predicate.values).toEqual([['QM4EZDV15JL8']]);
    expect(predicate.text).not.toContain('contractor_name');
  });

  it('matches reviewed names without requiring a blank source UEI on name-fallback rails', () => {
    const predicate = awardIdentityRailSql(
      rail({
        basis: 'reviewed_name_fallback',
        fallbackNames: ['l3harris technologies, inc.'],
      }),
    )!;
    expect(predicate.text).toBe('lower(contractor_name) = ANY($1::text[])');
    expect(predicate.values).toEqual([['l3harris technologies, inc.']]);
    expect(predicate.text).not.toContain('NULLIF');
  });

  it('returns null for an empty none rail', () => {
    expect(awardIdentityRailSql(rail({ basis: 'none' }))).toBeNull();
  });

  it('binds custom participant columns for subaward primes', () => {
    const predicate = awardIdentityRailSql(
      rail({ basis: 'exact_uei', ueis: ['AAA111BBB222'] }),
      Prisma.sql`prime_recipient_uei`,
      Prisma.sql`prime_recipient_name`,
    )!;
    expect(predicate.text).toBe('prime_recipient_uei = ANY($1::text[])');
  });
});
