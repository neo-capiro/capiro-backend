import { MeriToolsService } from './meri-tools.service.js';

/**
 * SC2.4 contract for search_cbo_cost_estimates: bill→estimate mapping where one
 * exists, and an EXPLICIT no-estimate answer (never a guess) where none does.
 * Invokes the private impl via prototype-call with a fake prisma — the method
 * has no other dependencies.
 */
describe('search_cbo_cost_estimates (SC2.4)', () => {
  const invoke = (rows: unknown[], input: Record<string, unknown>) =>
    (
      MeriToolsService.prototype as unknown as {
        searchCboCostEstimates(i: Record<string, unknown>): Promise<Record<string, unknown>>;
      }
    ).searchCboCostEstimates.call(
      { prisma: { cboCostEstimate: { findMany: async () => rows } } },
      input,
    );

  it('returns estimates when they exist', async () => {
    const row = {
      id: '62540',
      billId: '119-hr-8800',
      congress: 119,
      billType: 'hr',
      billNumber: '8800',
      title: 'H.R. 8800, NDAA FY2027',
      description: null,
      pubDate: new Date('2026-06-01'),
      cboUrl: 'https://www.cbo.gov/publication/62540',
    };
    const out = (await invoke([row], { billId: '119-hr-8800' })) as {
      estimatesFound: number;
      estimates: unknown[];
      note?: string;
    };
    expect(out.estimatesFound).toBe(1);
    expect(out.note).toBeUndefined();
  });

  it('says NO ESTIMATE explicitly (never guesses) when none exists', async () => {
    const out = (await invoke([], { billId: '119-hr-9999' })) as {
      estimatesFound: number;
      note: string;
    };
    expect(out.estimatesFound).toBe(0);
    expect(out.note).toContain('No CBO cost estimate on record for 119-hr-9999');
    expect(out.note).toContain('do not estimate or guess');
  });
});

/** Evaluate the emitted Prisma contains value with SQL LIKE wildcard/escape
 * semantics, so an unescaped keyword can select a poisoned row before LIMIT. */
function likeContains(title: string, pattern: string): boolean {
  const escape = (character: string) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let expression = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '\\' && index + 1 < pattern.length) expression += escape(pattern[++index]!);
    else expression += character === '%' ? '[\\s\\S]*' : character === '_' ? '[\\s\\S]' : escape(character);
  }
  return new RegExp(expression, 'i').test(title);
}

const estimate = (id: string, title: string, billId = '119-hr-8800', congress = 119) => ({
  id, billId, congress, billType: 'hr', billNumber: '8800', title, description: null,
  pubDate: new Date('2026-06-01T00:00:00.000Z'), cboUrl: `https://www.cbo.gov/publication/${id}`,
});

async function searchStoredEstimates(rows: ReturnType<typeof estimate>[], input: Record<string, unknown>) {
  const findMany = async ({ where, take }: { where: { title?: { contains: string }; billId?: string; congress?: number }; take: number }) =>
    rows.filter(row => (!where.title || likeContains(row.title, where.title.contains)) &&
      (where.billId === undefined || row.billId === where.billId) &&
      (where.congress === undefined || row.congress === where.congress)).slice(0, take);
  return (MeriToolsService.prototype as unknown as {
    searchCboCostEstimates(input: Record<string, unknown>): Promise<{ estimatesFound: number; estimates: ReturnType<typeof estimate>[]; note?: string }>;
  }).searchCboCostEstimates.call({ prisma: { cboCostEstimate: { findMany } } }, input);
}

describe('CBO literal title search', () => {
  test.each([
    ['95% accuracy', '95 percent accuracy'],
    ['unmanned_aircraft', 'unmanned aircraft'],
    ['path\\to', 'pathto'],
  ])('preserves literal %s before limiting the result window', async (query, unrelated) => {
    const rows = [...Array.from({ length: 30 }, (_, index) => estimate(String(60000 + index), unrelated)), estimate('70000', `Stored ${query} estimate`)];
    const page = await searchStoredEstimates(rows, { query, limit: 1 });
    expect(page.estimatesFound).toBe(1);
    expect(page.estimates.map(row => row.id)).toEqual(['70000']);
  });

  test('keeps ordinary keyword matching case insensitive', async () => {
    const page = await searchStoredEstimates([estimate('60000', 'Unrelated estimate'), estimate('70000', 'Aircraft estimate')], { query: 'aIrCrAfT', limit: 1 });
    expect(page.estimates.map(row => row.id)).toEqual(['70000']);
  });

  test.each([{}, { query: '   ' }])('keeps an omitted or blank title filter unselected', async input => {
    const page = await searchStoredEstimates([estimate('70000', 'Unrelated estimate')], input);
    expect(page.estimates.map(row => row.id)).toEqual(['70000']);
  });

  test('intersects literal title search with exact bill and Congress selectors', async () => {
    const page = await searchStoredEstimates([
      estimate('60000', '95% accuracy', '119-hr-9999'),
      estimate('60001', '95% accuracy', '119-hr-8800', 118),
      estimate('60002', '95 percent accuracy'),
      estimate('70000', '95% accuracy'),
    ], { query: '95% accuracy', billId: '119-hr-8800', congress: 119, limit: 1 });
    expect(page.estimates.map(row => row.id)).toEqual(['70000']);
  });

  test('no literal match remains an explicit empty estimate result', async () => {
    const page = await searchStoredEstimates([estimate('60000', '95 percent accuracy')], { query: '95% accuracy' });
    expect(page).toMatchObject({ estimatesFound: 0, estimates: [], note: 'No CBO cost estimates matched. Say so explicitly — do not estimate or guess a score.' });
  });
});
