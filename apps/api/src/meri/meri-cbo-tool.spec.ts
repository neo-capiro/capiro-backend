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
