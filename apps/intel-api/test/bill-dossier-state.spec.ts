import { BillDossierService } from '../src/bill-dossier/bill-dossier.service.js';
import type {
  SourceStateBill,
  SourceStateVote,
  SourceMovedCompanion,
} from '../src/sourcedata/state-source-data.repository.js';
import type { SourceBillAction } from '../src/sourcedata/source-data.repository.js';

/**
 * State-bill dossier behavior (§1.5, §5 edge case 8). A DD1 key routes to the
 * state-aware repository: real state status ladder + actions + votes + companion
 * links, federal-only governing-rule sections hidden, and funding returned as
 * unsupported (never $0).
 */

const KEY = 'tx-2025-hb1234';

const stateBill: SourceStateBill = {
  id: KEY,
  state: 'TX',
  sessionKey: '2025',
  identifier: 'HB 1234',
  title: 'A Texas measure',
  status: 'in_committee',
  statusAt: new Date('2026-04-10T00:00:00Z'),
  latestActionText: 'Referred to Committee on State Affairs.',
  latestActionDate: new Date('2026-04-10T00:00:00Z'),
  textDate: new Date('2026-04-09T00:00:00Z'),
  sponsorName: 'Rep. Lone Star',
  sponsorParty: 'R',
  sponsorCount: 3,
  stateUrl: 'https://capitol.texas.gov/BillLookup/History.aspx?LegSess=89R&Bill=HB1234',
  url: null,
  subjects: ['State Affairs'],
};

const stateActions: SourceBillAction[] = [
  { id: 's1', billId: KEY, date: new Date('2026-03-01T00:00:00Z'), text: 'Filed.', type: null, chamber: 'lower' },
  { id: 's2', billId: KEY, date: new Date('2026-04-10T00:00:00Z'), text: 'Referred to Committee on State Affairs.', type: null, chamber: 'lower' },
];

const stateVotes: SourceStateVote[] = [
  {
    billKey: KEY,
    chamber: 'lower',
    motion: 'Committee report adopted',
    yeas: 7,
    nays: 2,
    passed: true,
    date: new Date('2026-04-12T00:00:00Z'),
    sourceUrl: null,
    lastSyncedAt: new Date('2026-04-13T00:00:00Z'),
  },
];

const companions: SourceMovedCompanion[] = [
  {
    billKey: KEY,
    relatedBillKey: 'tx-2025-sb567',
    relatedDisplay: 'SB 567',
    relatedStatus: 'passed_lower',
    relatedStatusAt: new Date('2026-04-15T00:00:00Z'),
    linkType: 'companion',
  },
];

function makeStateSource(overrides: Record<string, unknown> = {}) {
  return {
    getStateBillById: async (id: string) => (id === KEY ? stateBill : null),
    getStateBillActionsByIds: async () => stateActions,
    getStateVotesForBills: async () => stateVotes,
    getMovedCompanions: async () => companions,
    ...overrides,
  };
}

describe('BillDossierService — state rail', () => {
  it('routes a DD1 state key to the state repository and marks the bill as state', async () => {
    const svc = new BillDossierService({} as never, {} as never, makeStateSource() as never);
    const d = await svc.getGlobalDossier(KEY);
    expect(d.bill.isState).toBe(true);
    expect(d.bill.jurisdiction).toBe('TX');
    expect(d.bill.num).toContain('HB');
  });

  it('hides federal-only governing-rule sections', async () => {
    const svc = new BillDossierService({} as never, {} as never, makeStateSource() as never);
    const d = await svc.getGlobalDossier(KEY);
    expect(d.governingRules).toEqual([]);
  });

  it('returns funding as unsupported (never $0)', async () => {
    const svc = new BillDossierService({} as never, {} as never, makeStateSource() as never);
    const d = await svc.getGlobalDossier(KEY);
    expect(d.funding.available).toBe(false);
    expect(d.funding.status ?? '').toMatch(/state funding data is not available/i);
    expect(d.funding.positions).toEqual([]);
  });

  it('includes state votes and companion links as related vehicles', async () => {
    const svc = new BillDossierService({} as never, {} as never, makeStateSource() as never);
    const d = await svc.getGlobalDossier(KEY);
    expect(d.votes[0]?.result).toBe('Passed');
    expect(d.noVote).toBeNull();
    expect(d.relatedVehicles[0]).toMatchObject({ billId: 'tx-2025-sb567', role: 'companion' });
  });

  it('404s an unknown state bill', async () => {
    const svc = new BillDossierService(
      {} as never,
      {} as never,
      makeStateSource({ getStateBillById: async () => null }) as never,
    );
    await expect(svc.getGlobalDossier('tx-2025-hb9999')).rejects.toThrow(/BILL_NOT_FOUND/);
  });
});
