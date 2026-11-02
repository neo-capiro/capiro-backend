import { Prisma, PrismaClient } from '@prisma/client';
import { matchingBillIdsSql } from './bill-keyword-match.helpers.js';

jest.setTimeout(60_000);

// Disposable native PostgreSQL only. The catalog tables are session temp tables
// inside a rolled-back transaction, so no migration chain is required.
const describeDb =
  process.env.DATABASE_URL && process.env.CAPIRO_DISPOSABLE_PG === '1' ? describe : describe.skip;

/** The original matcher: one regex clause per term per row (the result-set oracle). */
function perTermBillIdsSql(terms: string[], congress?: number, includePolicyRegex = true) {
  const lowerTerms = terms.map((term) => term.toLowerCase());
  const wordPatterns = lowerTerms.map((term) => `\\m${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`);
  const any = (column: Prisma.Sql, equality: boolean, regex: boolean) => {
    const clauses: Prisma.Sql[] = [];
    if (equality && lowerTerms.length) clauses.push(Prisma.sql`${column} = ANY(${lowerTerms}::text[])`);
    if (regex) for (const pattern of wordPatterns) clauses.push(Prisma.sql`${column} ~ ${pattern}`);
    return clauses.length ? Prisma.sql`(${Prisma.join(clauses, ' OR ')})` : Prisma.sql`FALSE`;
  };
  const inCongress = congress != null ? Prisma.sql`cb.congress = ${congress} AND ` : Prisma.empty;
  return Prisma.sql`(
    SELECT cb.id FROM congress_bill cb
    WHERE ${inCongress}(${any(Prisma.sql`LOWER(cb.policy_area)`, true, includePolicyRegex)}
      OR ${any(Prisma.sql`LOWER(cb.title)`, false, true)})
    UNION
    SELECT cb.id FROM congress_bill cb JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
    WHERE ${inCongress}${any(Prisma.sql`LOWER(cbs.name)`, true, true)}
  )`;
}

const ordered = (ids: Prisma.Sql) =>
  Prisma.sql`SELECT cb.id FROM congress_bill cb WHERE cb.id IN (SELECT id FROM ${ids} AS m)
    ORDER BY cb.latest_action_date DESC NULLS LAST, cb.id`;

describeDb('bill keyword matcher on native PostgreSQL', () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());

  async function withCatalog(check: (tx: Prisma.TransactionClient) => Promise<void>) {
    const rollback = new Error('intentional fixture rollback');
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE congress_bill (id text PRIMARY KEY, congress int NOT NULL,
        title text NOT NULL, policy_area text, latest_action_date date) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE congress_bill_subject (id serial PRIMARY KEY,
        bill_id text NOT NULL, name text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO congress_bill VALUES
        ('119-hr-1', 119, 'National Defense Authorization Act', 'Armed Forces and National Security', '2026-03-01'),
        ('119-hr-2', 119, 'A defenseless title that must not match', NULL, '2026-02-01'),
        ('119-hr-3', 119, 'Water resources development', 'Water Resources Development', NULL),
        ('119-hr-4', 119, 'Programming in C++ for agencies', 'Science, Technology, Communications', '2026-01-01'),
        ('119-s-5', 119, 'An unrelated title', 'Health', '2026-01-15'),
        ('118-hr-6', 118, 'Cyber workforce act', 'Armed Forces and National Security', '2024-05-01'),
        ('118-s-7', 118, 'Untitled measure', NULL, '2024-06-01'),
        ('119-s-8', 119, 'Another unrelated title', 'Taxation', '2026-04-01'),
        ('119-hr-10', 119, 'Review of section a\\b and 50_50 cost shares', NULL, '2026-05-01'),
        ('119-hr-11', 119, 'The 50x50 act', NULL, '2026-05-02')`);
      await tx.$executeRawUnsafe(`INSERT INTO congress_bill_subject (bill_id, name) VALUES
        ('119-s-5', 'Cybersecurity and identity theft'),
        ('119-s-5', 'Health'),
        ('118-s-7', 'CYBER'),
        ('119-s-8', NULL),
        ('119-s-8', 'Military readiness'),
        ('999-hr-9', 'Cyber')`);
      await check(tx);
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
  }

  const terms = ['Defense', 'c++', 'Armed Forces and National Security', 'Cyber', 'water resources development', 'military', 'a\\b', '50_50'];

  it('returns the same ordered bills as one regex clause per term', async () => {
    await withCatalog(async (tx) => {
      const current = await tx.$queryRaw<Array<{ id: string }>>(ordered(matchingBillIdsSql(terms)));
      const oracle = await tx.$queryRaw<Array<{ id: string }>>(ordered(perTermBillIdsSql(terms)));
      expect(current).toEqual(oracle);
      // Whole words only ("defenseless" is not "defense", "Cybersecurity" is not
      // "cyber"), exact-name equality, regex and LIKE metacharacters (+, _, \)
      // taken literally ("50x50" is not "50_50"), NULLs and orphaned subjects excluded.
      expect(current.map((row) => row.id)).toEqual(['119-hr-10', '119-s-8', '119-hr-1', '118-s-7', '118-hr-6', '119-hr-3']);
    });
  });

  it('keeps the tracker shape: one Congress and no policy-area regex', async () => {
    await withCatalog(async (tx) => {
      const tracker = ['water', 'cyber', 'armed forces and national security'];
      const current = await tx.$queryRaw<Array<{ id: string }>>(
        ordered(matchingBillIdsSql(tracker, { congress: 119, includePolicyRegex: false })));
      const oracle = await tx.$queryRaw<Array<{ id: string }>>(ordered(perTermBillIdsSql(tracker, 119, false)));
      expect(current).toEqual(oracle);
      // "Water Resources Development" is a policy area: no regex on it here, but
      // the title still matches whole-word "water".
      expect(current.map((row) => row.id)).toEqual(['119-hr-1', '119-hr-3']);
    });
  });

  it('matches nothing without terms', async () => {
    await withCatalog(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(ordered(matchingBillIdsSql([])));
      expect(rows).toEqual([]);
    });
  });
});
