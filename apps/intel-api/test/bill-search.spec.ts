import { TrackerBoardService, billSearchPatterns } from '../src/tracker/tracker-board.service.js';
import { currentCongress } from '../src/tracker/bill-stage.util.js';

/**
 * P1.1 — Add-bill-modal search, ported from apps/api tracker.service.searchBills.
 * Pure-unit: the pattern builder is a pure export; the service is exercised with
 * a mocked SourceDataRepository (no DB).
 */
describe('billSearchPatterns', () => {
  it('builds the bill-id token: "H.R. 4455" → %hr-4455%', () => {
    const { titleLike, idLike } = billSearchPatterns('H.R. 4455');
    expect(idLike).toBe('%hr-4455%');
    expect(titleLike).toBe('%h.r. 4455%');
  });

  it('handles already-hyphenless forms ("hr4455") and plain keywords', () => {
    expect(billSearchPatterns('hr4455').idLike).toBe('%hr-4455%');
    expect(billSearchPatterns('S. 1932').idLike).toBe('%s-1932%');
    // No leading alpha+digit boundary → keyword passes through un-hyphenated.
    expect(billSearchPatterns('data center').idLike).toBe('%datacenter%');
    expect(billSearchPatterns('Data Center').titleLike).toBe('%data center%');
  });
});

describe('TrackerBoardService.searchBills', () => {
  function svcWith(rows: any[]) {
    let calledWith: any[] | null = null;
    const repo = {
      searchBillRows: async (...args: any[]) => {
        calledWith = args;
        return rows;
      },
    } as any;
    const svc = new TrackerBoardService({} as any, repo, {} as any);
    return { svc, getArgs: () => calledWith };
  }

  it('returns [] for <2 chars without hitting the repo', async () => {
    const { svc, getArgs } = svcWith([]);
    expect(await svc.searchBills(' h ')).toEqual([]);
    expect(getArgs()).toBeNull();
  });

  it('passes bound patterns + the current Congress to the repo', async () => {
    const { svc, getArgs } = svcWith([]);
    await svc.searchBills('H.R. 4455');
    expect(getArgs()).toEqual(['%h.r. 4455%', '%hr-4455%', currentCongress()]);
  });

  it('maps rows to the legacy BillSearchResult shape', async () => {
    const { svc } = svcWith([
      {
        id: '119-hr-4455',
        title: 'Grid Reliability Act',
        latestActionText: 'Referred to the Committee on Energy and Commerce.',
        latestActionDate: new Date('2026-06-01'),
      },
    ]);
    const [r] = await svc.searchBills('grid');
    expect(r).toMatchObject({
      billId: '119-hr-4455',
      displayNum: 'H.R. 4455',
      title: 'Grid Reliability Act',
      stage: 'committee',
    });
    expect(r!.probability).toBeGreaterThan(0);
    expect(r!.probability).toBeLessThanOrEqual(0.97);
  });
});
