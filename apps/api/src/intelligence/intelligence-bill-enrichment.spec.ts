import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { IntelligenceBillEnrichment, billIdentifierSearch } from './intelligence-bill-enrichment.js';
import { clientIntelligenceReads } from './client-read-cache.js';

describe('billIdentifierSearch', () => {
  it('builds one alternation that matches both "HR 1234" and "HR1234" spellings', () => {
    const search = billIdentifierSearch([{ identifier: '119-hr-1234' }, { identifier: '119-s-55' }, { identifier: '119-hr-1234' }]);
    expect(search).not.toBeNull();
    expect(search!.pattern).toBe('(HR ?1234|S ?55)');
    const re = new RegExp(search!.pattern, 'i');
    for (const text of ['Implementing HR 1234 reporting', 'Section 3 of hr1234', 'Pursuant to S 55', 'S55 of 2025']) {
      expect(re.test(text)).toBe(true);
    }
    expect(re.test('HR 123')).toBe(false);
    expect(re.test('HR 12345')).toBe(true); // substring semantics, unchanged from the former ILIKE list
  });

  it('bounds the identifier branch to the earliest tracked Congress start', () => {
    expect(billIdentifierSearch([{ identifier: '119-hr-1' }])!.publishedSince.toISOString()).toBe('2025-01-03T00:00:00.000Z');
    expect(billIdentifierSearch([{ identifier: '119-hr-1' }, { identifier: '118-s-9' }])!.publishedSince.toISOString()).toBe('2023-01-03T00:00:00.000Z');
  });

  it('ignores identifiers that cannot be parsed and returns null when none can', () => {
    expect(billIdentifierSearch([{ identifier: 'bad' }, { identifier: 'x-hr-1' }, { identifier: '119-hr-1a' }])).toBeNull();
    expect(billIdentifierSearch([{ identifier: 'bad' }, { identifier: '119-hjres-7' }])!.pattern).toBe('(HJRES ?7)');
  });
});

describe('IntelligenceBillEnrichment.getBillRegulationLinks', () => {
  function harness(rows: unknown[] = []) {
    const executed: Prisma.Sql[] = [];
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async (sql: Prisma.Sql) => { executed.push(sql); return rows; }),
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (value: typeof tx) => Promise<unknown>, _options?: unknown) => fn(tx)),
    } as unknown as PrismaService;
    const tracked = {
      total: 2, issueCodes: [],
      bills: [
        { identifier: '119-hr-1234', title: 'A', latestActionDate: null, latestActionText: null, sponsorName: null, sponsorParty: null, subjectNames: ['Defense'], isManual: false },
        { identifier: '119-s-55', title: 'B', latestActionDate: null, latestActionText: null, sponsorName: null, sponsorParty: null, subjectNames: ['Energy'], isManual: true },
      ],
    };
    const reads = clientIntelligenceReads({});
    const service = new IntelligenceBillEnrichment(prisma, { clientReads: () => reads, getTrackedBills: jest.fn(async () => tracked) } as never);
    return { service, tx, prisma, executed, tracked };
  }

  it('runs one bounded statement under the bill-read deadline with a topics branch and a regex identifier branch', async () => {
    const h = harness();
    const result = await h.service.getBillRegulationLinks('client-1', 'tenant-1');
    expect(result).toEqual({ links: [], totalBills: 2, totalRegulations: 0 });
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const timeoutCall = (h.tx.$executeRaw.mock.calls as unknown as unknown[][])[0]!;
    expect((timeoutCall[0] as string[]).join('?')).toContain("set_config('statement_timeout'");
    expect(h.executed).toHaveLength(1);
    const sql = h.executed[0]!;
    expect(sql.sql).toContain('WHERE topics && ?::text[]');
    expect(sql.sql).toContain('OR (publication_date >= ?::date');
    expect(sql.sql).toContain('title ~* ? OR abstract ~* ?');
    expect(sql.sql).not.toContain('ILIKE ANY');
    expect(sql.sql).toContain('LIMIT 200');
    expect(sql.values).toEqual([['Defense', 'Energy'], new Date('2025-01-03T00:00:00.000Z'), '(HR ?1234|S ?55)', '(HR ?1234|S ?55)']);
  });

  it('keeps only the topics branch when no identifier parses', async () => {
    const h = harness();
    h.tracked.bills.forEach((bill) => { bill.identifier = 'unknown'; });
    await h.service.getBillRegulationLinks('client-1', 'tenant-1', h.tracked);
    const sql = h.executed[0]!;
    expect(sql.sql).not.toContain('publication_date >=');
    expect(sql.values).toEqual([['Defense', 'Energy']]);
  });

  it('answers without touching the database when nothing is tracked', async () => {
    const h = harness();
    await expect(h.service.getBillRegulationLinks('client-1', 'tenant-1', { total: 0, issueCodes: [], bills: [] }))
      .resolves.toEqual({ links: [], totalBills: 0, totalRegulations: 0 });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
