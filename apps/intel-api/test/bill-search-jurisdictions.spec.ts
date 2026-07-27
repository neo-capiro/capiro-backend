/**
 * Gate D phase f (P1-17) — the Add Bill modal could not find a state bill.
 *
 * `searchBills` queried the current-Congress federal corpus only, while the
 * modal's copy claimed it searched the congressional record. A client could
 * enable state jurisdictions, receive state recommendations, and still be
 * unable to add a state bill it had missed.
 */
import { TrackerBoardService, billSearchPatterns } from '../src/tracker/tracker-board.service.js';

const FEDERAL_ROW = {
  id: '119-hr-4455',
  title: 'Grid Modernization Act',
  latestActionText: 'Referred to the Committee on Energy and Commerce.',
  latestActionDate: new Date('2026-02-01T00:00:00Z'),
};
const CA_ROW = {
  id: 'ca-20252026-AB1234',
  state: 'CA',
  identifier: 'AB 1234',
  title: 'California Housing Density Act',
  latestActionText: 'Referred to Committee on Housing.',
  latestActionDate: new Date('2026-02-10T00:00:00Z'),
};

function makeSvc() {
  const searchBillRows = jest.fn().mockResolvedValue([FEDERAL_ROW]);
  const searchStateBillRows = jest.fn().mockResolvedValue([CA_ROW]);
  // Constructor order: (prisma, repo, watchlists, stateRepo).
  const svc = new TrackerBoardService(
    {} as never,
    { searchBillRows } as never,
    {} as never,
    { searchStateBillRows } as never,
  );
  return { svc, searchBillRows, searchStateBillRows };
}

describe('billSearchPatterns', () => {
  it('builds a title pattern and a normalized id pattern', () => {
    expect(billSearchPatterns('H.R. 4455')).toEqual({
      titleLike: '%h.r. 4455%',
      idLike: '%hr-4455%',
    });
  });
});

describe('searchBills — jurisdictions (P1-17)', () => {
  it('returns [] for a query under 2 characters, touching neither rail', async () => {
    const { svc, searchBillRows, searchStateBillRows } = makeSvc();
    expect(await svc.searchBills('a')).toEqual([]);
    expect(searchBillRows).not.toHaveBeenCalled();
    expect(searchStateBillRows).not.toHaveBeenCalled();
  });

  /** Back-compat: an existing caller sends only `q`. */
  it('with NO jurisdictions searches federal only — unchanged for existing callers', async () => {
    const { svc, searchBillRows, searchStateBillRows } = makeSvc();
    const out = await svc.searchBills('housing');
    expect(searchBillRows).toHaveBeenCalled();
    // Never scans all 50 legislatures on an unqualified query.
    expect(searchStateBillRows).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]!.jurisdiction).toBe('US');
  });

  /** f-6 case 4. */
  it("with ['US'] returns federal only", async () => {
    const { svc, searchStateBillRows } = makeSvc();
    const out = await svc.searchBills('housing', { jurisdictions: ['US'] });
    expect(searchStateBillRows).not.toHaveBeenCalled();
    expect(out.every((r) => r.jurisdiction === 'US')).toBe(true);
  });

  it("with ['CA'] returns state results labelled CA and skips the federal rail", async () => {
    const { svc, searchBillRows, searchStateBillRows } = makeSvc();
    const out = await svc.searchBills('housing', { jurisdictions: ['CA'] });
    expect(searchBillRows).not.toHaveBeenCalled();
    expect(searchStateBillRows).toHaveBeenCalledWith(
      '%housing%',
      expect.any(String),
      ['CA'],
      expect.any(Number),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.jurisdiction).toBe('CA');
    expect(out[0]!.billId).toBe('ca-20252026-AB1234');
  });

  it("with ['US','CA'] returns BOTH rails, each labelled", async () => {
    const { svc } = makeSvc();
    const out = await svc.searchBills('housing', { jurisdictions: ['US', 'CA'] });
    expect(out.map((r) => r.jurisdiction).sort()).toEqual(['CA', 'US']);
  });

  it('lower-cased or padded jurisdiction codes still route correctly', async () => {
    const { svc, searchStateBillRows } = makeSvc();
    await svc.searchBills('housing', { jurisdictions: [' ca ', 'us'] });
    expect(searchStateBillRows).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      ['CA'],
      expect.any(Number),
    );
  });

  it('caps the merged result set at the requested limit', async () => {
    const { svc, searchBillRows } = makeSvc();
    searchBillRows.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ ...FEDERAL_ROW, id: `119-hr-${i}` })),
    );
    const out = await svc.searchBills('housing', { jurisdictions: ['US'], limit: 5 });
    expect(out).toHaveLength(5);
  });
});
