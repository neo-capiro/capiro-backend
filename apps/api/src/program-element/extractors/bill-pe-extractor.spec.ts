import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  BillPeExtractorService,
  extractProgramCodes,
  type BillForExtraction,
} from './bill-pe-extractor.service.js';

describe('extractProgramCodes', () => {
  test('"PE 0603270A and PE 0603250F" → ["0603270A", "0603250F"]', () => {
    expect(extractProgramCodes('PE 0603270A and PE 0603250F').sort()).toEqual([
      '0603250F',
      '0603270A',
    ]);
  });

  test('dedupes and uppercases', () => {
    expect(extractProgramCodes('0603270a 0603270A 0603270a')).toEqual(['0603270A']);
  });

  test('ignores numbers that are not PE-shaped', () => {
    expect(
      extractProgramCodes('budget of 1234567 dollars, line 060327 and 0603270 (no letter)'),
    ).toEqual([]);
  });

  test('returns [] for empty/blank', () => {
    expect(extractProgramCodes('')).toEqual([]);
  });

  test('also extracts procurement BLINs (appropriation + line item), not just PE codes', () => {
    // 1242C93000: Army procurement BLIN shape (4-digit appropriation + letter(s) + line#).
    expect(extractProgramCodes('Line 1242C93000, Air Defense Targets')).toEqual(['1242C93000']);
  });

  test('extracts both a PE code and a BLIN from the same text', () => {
    expect(extractProgramCodes('0603270A and 1242C93000 both appear here').sort()).toEqual([
      '0603270A',
      '1242C93000',
    ]);
  });

  test('a real PE code is not also double-matched as a BLIN', () => {
    // Sanity check: the PE-shape branch should win outright for a PE-shaped token —
    // no duplicate/overlapping BLIN-shaped submatch from the same code.
    expect(extractProgramCodes('0603270A')).toEqual(['0603270A']);
  });
});

interface BillRow extends BillForExtraction {}

function makeService(opts?: {
  existingPeCodes?: string[];
  watches?: Array<{ tenantId: string; peCode: string }>;
  cachedText?: string | null;
}) {
  const existing = new Set(opts?.existingPeCodes ?? []);
  const updates: Array<{ id: string; peCodes: string[] }> = [];
  const emitted: Array<Record<string, unknown>> = [];
  const linkRows: string[] = [];

  // Stub tx handed to withSystem — it sets app.bypass_rls, so it is the only path on
  // which RLS-FORCED program_element_watch rows are visible to the app role.
  const systemTx = {
    programElementWatch: {
      findMany: jest.fn(async ({ where }: { where: { peCode: { in: string[] } } }) =>
        (opts?.watches ?? []).filter((w) => where.peCode.in.includes(w.peCode)),
      ),
    },
  };

  const prisma = {
    congressBill: {
      findMany: jest.fn(async () => [] as BillRow[]),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: { peCodes: string[] } }) => {
          updates.push({ id: where.id, peCodes: data.peCodes });
          return {};
        },
      ),
    },
    programElement: {
      findMany: jest.fn(async ({ where }: { where: { peCode: { in: string[] } } }) => {
        return where.peCode.in.filter((c) => existing.has(c)).map((peCode) => ({ peCode }));
      }),
    },
    billText: {
      findUnique: jest.fn(async () => (opts?.cachedText ? { textContent: opts.cachedText } : null)),
      upsert: jest.fn(async () => ({})),
    },
    // processBill always calls syncLinkRows (LEG-B evidence rows) before maybeEmit, so
    // this stub is required for ANY test in this file to reach an assertion. It was
    // missing, which failed every test in the suite from #223 onward — including the
    // watch/emission tests that are this file's whole point. bill_budget_line_link is a
    // global table (no tenant_id), so no tenant scoping applies to it.
    billBudgetLineLink: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      upsert: jest.fn(async ({ create }: { create: { peCode: string } }) => {
        linkRows.push(create.peCode);
        return {};
      }),
    },
    // program_element_watch is RLS-FORCED as of the Phase C tenant-isolation migration
    // and capiro_app is NOT BYPASSRLS since the 2026-07-20 role hardening, so a read that
    // skips withSystem returns ZERO rows with no error — and maybeEmit turns that into
    // "nobody watches this PE" and emits nothing, permanently and silently. This bare
    // accessor serves [] so the watch-driven tests below actually detect that.
    programElementWatch: {
      findMany: jest.fn(async () => [] as Array<{ tenantId: string; peCode: string }>),
    },
    // The bypass path is the only one on which watch rows are visible.
    withSystem: jest.fn(async (fn: (tx: typeof systemTx) => unknown) => fn(systemTx)),
    intelligenceChange: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        emitted.push(data);
        return {};
      }),
    },
  };

  const govInfo = { getBillText: jest.fn(async () => ({ xml: '', sections: [] })) };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test injection
  const svc = new BillPeExtractorService(prisma as any, govInfo as any);
  return { svc, prisma, govInfo, updates, emitted, linkRows };
}

function bill(partial: Partial<BillRow>): BillRow {
  return {
    id: '119-hr-1',
    congress: 119,
    billType: 'hr',
    billNumber: '1',
    title: null,
    latestActionText: null,
    peCodes: [],
    ...partial,
  };
}

describe('BillPeExtractorService.processBill', () => {
  test('keeps only PE codes that exist in program_element (filters false positives)', async () => {
    const { svc, updates } = makeService({ existingPeCodes: ['0603270A'] });
    const result = await svc.processBill(bill({ title: 'Mentions 0603270A and 0603250F' }), {
      fetchFullText: false,
    });

    // 0603250F is PE-shaped but not in the DB → filtered out.
    expect(result.peCodes).toEqual(['0603270A']);
    expect(updates).toEqual([{ id: '119-hr-1', peCodes: ['0603270A'] }]);
  });

  test('is idempotent — re-running with the same set does not update or emit', async () => {
    const { svc, prisma, updates, emitted } = makeService({ existingPeCodes: ['0603270A'] });
    const b = bill({ title: 'Has 0603270A', peCodes: ['0603270A'] });

    const result = await svc.processBill(b, { fetchFullText: false });

    expect(result.changed).toBe(false);
    expect(updates).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(prisma.congressBill.update).not.toHaveBeenCalled();
  });

  test('emits IntelligenceChange only when a newly-added PE is watched', async () => {
    const { svc, emitted } = makeService({
      existingPeCodes: ['0603270A'],
      watches: [{ tenantId: 't1', peCode: '0603270A' }],
    });
    const result = await svc.processBill(bill({ title: 'New ref 0603270A' }), {
      fetchFullText: false,
    });

    expect(result.emitted).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      source: 'congress_bill',
      changeType: 'bill_pe_linked',
      relatedPeCodes: ['0603270A'],
    });
  });

  test('reads program_element_watch on the bypass path (RLS-forced as of Phase C)', async () => {
    // Regression guard. maybeEmit early-returns false when the watch query comes back
    // empty, so a read that skips withSystem does not fail loudly — it just stops
    // emitting bill_pe_linked alerts for every tenant, forever, with nothing logged.
    // Assert the emission happened AND that the bypass client is what served it.
    const { svc, prisma, emitted } = makeService({
      existingPeCodes: ['0603270A'],
      watches: [{ tenantId: 't1', peCode: '0603270A' }],
    });

    const result = await svc.processBill(bill({ title: 'New ref 0603270A' }), {
      fetchFullText: false,
    });

    expect(result.emitted).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(prisma.withSystem).toHaveBeenCalled();
    // The non-bypass client must never be consulted for this table.
    expect(prisma.programElementWatch.findMany).not.toHaveBeenCalled();
  });

  test('does NOT emit when the new PE is not watched', async () => {
    const { svc, emitted } = makeService({ existingPeCodes: ['0603270A'], watches: [] });
    const result = await svc.processBill(bill({ title: 'New ref 0603270A' }), {
      fetchFullText: false,
    });

    expect(result.changed).toBe(true);
    expect(result.emitted).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test('scans cached full text from bill_text when fetchFullText is on', async () => {
    const { svc } = makeService({
      existingPeCodes: ['0604201A'],
      cachedText: 'full text body PE 0604201A here',
    });
    const result = await svc.processBill(bill({ title: 'No code in title' }), {
      fetchFullText: true,
    });
    expect(result.peCodes).toEqual(['0604201A']);
  });
});
