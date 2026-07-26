import { ExplorerService } from './explorer.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The Explorer's awarded-federal-assistance source (WS-I).
 *
 * Three things this source must not get wrong, all of them ways a number can
 * become a lie:
 *
 *  - `total_obligated_amount` / `total_outlayed_amount` are Decimal(18,2). Left
 *    as Prisma Decimals they serialize as `{s,e,d}` objects; coerced with a
 *    bare `Number(x)` they turn null into 0. Committed-vs-paid are separate
 *    facts and are never summed.
 *  - Postgres defaults DESC to NULLS FIRST, so "largest obligated first" would
 *    lead with rows that report NO amount at all.
 *  - A district the operator typed cannot be parsed into the exact form the
 *    column stores must be IGNORED. Turning it into a filter that matches
 *    nothing reads as "this state has no awards", which is a wrong answer to a
 *    question the user did not ask.
 */

type FindManyArgs = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  take?: number;
  skip?: number;
};

/** Stands in for a Prisma Decimal: not a number, but numerically coercible. */
function decimal(value: string) {
  return {
    toString: () => value,
    valueOf: () => Number(value),
    toNumber: () => Number(value),
  };
}

const ROW = {
  id: 'faa-1',
  awardUniqueId: 'ASST_NON_1234_7300',
  fain: 'ABC123',
  recipientName: 'REGENTS OF THE UNIVERSITY OF TEXAS',
  recipientUei: 'ABC123DEF456',
  awardTypeCode: '04',
  awardTypeLabel: 'PROJECT GRANT (B)',
  awardingAgency: 'Department of Health and Human Services',
  awardingSubTier: 'National Institutes of Health',
  assistanceListingNumber: '93.847',
  assistanceListingTitle: 'Diabetes, Digestive, and Kidney Diseases Research',
  totalObligatedAmount: decimal('1250000.00'),
  totalOutlayedAmount: decimal('310500.50'),
  description: 'Research project grant',
  popState: 'TX',
  popCongressionalDistrict: '23',
  popCdVintage: 'original',
  startDate: new Date('2024-09-01T00:00:00.000Z'),
  endDate: new Date('2027-08-31T00:00:00.000Z'),
};

function makePrisma(rows: unknown[] = [ROW]) {
  const findMany = jest.fn(async (_args: FindManyArgs) => rows);
  const count = jest.fn(async (_args: { where?: Record<string, unknown> }) => rows.length);
  return {
    prisma: {
      federalAssistanceAward: { findMany, count },
    } as unknown as PrismaService,
    findMany,
    count,
  };
}

/** The `where` the service actually handed Prisma. */
function whereOf(findMany: jest.Mock): Record<string, unknown> {
  return (findMany.mock.calls[0]![0] as FindManyArgs).where ?? {};
}

function orderByOf(findMany: jest.Mock): Record<string, unknown> {
  return (findMany.mock.calls[0]![0] as FindManyArgs).orderBy ?? {};
}

describe('ExplorerService.assistanceAwards — money coercion', () => {
  it('returns Decimal obligated/outlayed as numbers, not Decimal objects', async () => {
    const { prisma } = makePrisma();
    const { rows } = await new ExplorerService(prisma).assistanceAwards({});
    expect(typeof rows[0]!.totalObligatedAmount).toBe('number');
    expect(typeof rows[0]!.totalOutlayedAmount).toBe('number');
    expect(rows[0]!.totalObligatedAmount).toBe(1250000);
    expect(rows[0]!.totalOutlayedAmount).toBe(310500.5);
  });

  it('keeps a null amount null — never 0', async () => {
    const { prisma } = makePrisma([
      { ...ROW, totalObligatedAmount: null, totalOutlayedAmount: null },
    ]);
    const { rows } = await new ExplorerService(prisma).assistanceAwards({});
    expect(rows[0]!.totalObligatedAmount).toBeNull();
    expect(rows[0]!.totalOutlayedAmount).toBeNull();
  });

  it('reports obligated and outlayed as separate fields and never sums them', async () => {
    const { prisma } = makePrisma();
    const { rows } = await new ExplorerService(prisma).assistanceAwards({});
    expect(rows[0]!.totalObligatedAmount).not.toBe(rows[0]!.totalOutlayedAmount);
    expect(Object.keys(rows[0]!)).not.toContain('totalAmount');
  });
});

describe('ExplorerService.assistanceAwards — sort', () => {
  it('defaults to largest obligated first with NULLS LAST', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({});
    expect(orderByOf(findMany)).toEqual({
      totalObligatedAmount: { sort: 'desc', nulls: 'last' },
    });
  });

  it('sorts by start date descending, NULLS LAST, for sort=recent', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ sort: 'recent' });
    expect(orderByOf(findMany)).toEqual({ startDate: { sort: 'desc', nulls: 'last' } });
  });

  it('sorts by end date ascending, NULLS LAST, for sort=ending', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ sort: 'ending' });
    expect(orderByOf(findMany)).toEqual({ endDate: { sort: 'asc', nulls: 'last' } });
  });
});

describe('ExplorerService.assistanceAwards — district filter', () => {
  it('zero-pads a 1-char district to the stored 2-char form', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ district: '4' });
    expect(whereOf(findMany).popCongressionalDistrict).toBe('04');
  });

  it('maps the at-large spelling "al" to "00"', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ district: 'al' });
    expect(whereOf(findMany).popCongressionalDistrict).toBe('00');
  });

  it('passes the statewide sentinel "90" through verbatim', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ district: '90' });
    expect(whereOf(findMany).popCongressionalDistrict).toBe('90');
  });

  it('IGNORES an unparseable district rather than filtering to nothing', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ district: 'xyz' });
    // Not "=== undefined": the key must be ABSENT, so Prisma never emits the
    // predicate at all. A present-but-undefined key is the same bug wearing a
    // different hat.
    expect(whereOf(findMany)).not.toHaveProperty('popCongressionalDistrict');
  });

  it('ignores an empty district string', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ district: '' });
    expect(whereOf(findMany)).not.toHaveProperty('popCongressionalDistrict');
  });
});

describe('ExplorerService.assistanceAwards — search', () => {
  it('matches a UEI by exact uppercased equality, never by substring', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ q: 'abc123def456' });
    const or = whereOf(findMany).OR as Array<Record<string, unknown>>;
    const uei = or.find((clause) => 'recipientUei' in clause)!;
    expect(uei.recipientUei).toBe('ABC123DEF456');
    // The other clauses are substring matches; the UEI clause must not be.
    expect(uei.recipientUei).not.toHaveProperty('contains');
  });

  it('searches recipient, description, agency, listing title and FAIN as substrings', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ q: 'diabetes' });
    const or = whereOf(findMany).OR as Array<Record<string, unknown>>;
    const fields = or.flatMap((clause) => Object.keys(clause));
    expect(fields).toEqual(
      expect.arrayContaining([
        'recipientName',
        'description',
        'awardingAgency',
        'assistanceListingTitle',
        'fain',
        'recipientUei',
      ]),
    );
    expect(or.find((c) => 'recipientName' in c)!.recipientName).toEqual({
      contains: 'diabetes',
      mode: 'insensitive',
    });
  });
});

describe('ExplorerService.assistanceAwards — activeOnly', () => {
  it('adds an endDate >= now filter when activeOnly is true', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ activeOnly: true });
    const endDate = whereOf(findMany).endDate as { gte: Date };
    expect(endDate.gte).toBeInstanceOf(Date);
  });

  it('applies NO endDate filter when activeOnly is omitted — history stays visible', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({});
    expect(whereOf(findMany)).not.toHaveProperty('endDate');
  });

  it('applies NO endDate filter when activeOnly is false', async () => {
    const { prisma, findMany } = makePrisma();
    await new ExplorerService(prisma).assistanceAwards({ activeOnly: false });
    expect(whereOf(findMany)).not.toHaveProperty('endDate');
  });
});

describe('ExplorerService.assistanceAwards — url', () => {
  it('builds a USAspending award url from awardUniqueId', async () => {
    const { prisma } = makePrisma();
    const { rows } = await new ExplorerService(prisma).assistanceAwards({});
    expect(rows[0]!.url).toBe('https://www.usaspending.gov/award/ASST_NON_1234_7300');
  });

  it('returns a null url when awardUniqueId is null rather than a broken link', async () => {
    const { prisma } = makePrisma([{ ...ROW, awardUniqueId: null }]);
    const { rows } = await new ExplorerService(prisma).assistanceAwards({});
    expect(rows[0]!.url).toBeNull();
  });
});
