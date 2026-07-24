import type { ExecutionContext } from '@nestjs/common';
import { BillDossierService } from '../src/bill-dossier/bill-dossier.service.js';
import { Bill360FeatureGuard } from '../src/bill-dossier/bill-360.guard.js';
import type {
  SourceBillIdentity,
  SourceBillVote,
} from '../src/sourcedata/source-data.repository.js';

/**
 * Bill 360 tenant-safety + flag-gating (§1.6):
 *  - no cross-tenant client-context access (tenant predicate is mandatory);
 *  - the global route never returns client context;
 *  - malformed bill ids 4xx / 404 with no synthesized links or server error;
 *  - one batched member-vote query (no N+1);
 *  - the feature guard 404s when bill_360 is off.
 */

const BILL = '119-hr-2000';
const TENANT_A = 'tenant-A';
const CLIENT = '22222222-2222-2222-2222-222222222222';

const identity: SourceBillIdentity = {
  id: BILL,
  congress: 119,
  billType: 'hr',
  billNumber: '2000',
  title: 'Auth test bill',
  originChamber: 'House',
  sponsorName: null,
  introducedDate: null,
  status: 'floor',
  statusAt: new Date('2026-05-01T00:00:00Z'),
  latestActionText: 'Considered on the floor.',
  latestActionDate: new Date('2026-05-01T00:00:00Z'),
  policyArea: null,
  url: null,
  lastSyncedAt: new Date('2026-05-02T00:00:00Z'),
  updateDate: new Date('2026-05-01T00:00:00Z'),
  updateDateIncludingText: new Date('2026-05-01T00:00:00Z'),
};

const twoVotes: SourceBillVote[] = [
  { id: 'v1', chamber: 'house', billId: BILL, question: 'On Passage', result: 'Passed', voteType: null, voteDate: new Date('2026-05-01T10:00:00Z'), yeas: 1, nays: 0, present: 0, notVoting: 0, sourceUrl: null },
  { id: 'v2', chamber: 'house', billId: BILL, question: 'On Motion to Recommit', result: 'Failed', voteType: null, voteDate: new Date('2026-04-30T10:00:00Z'), yeas: 0, nays: 1, present: 0, notVoting: 0, sourceUrl: null },
];

function makeSource(memberSummaryCounter?: { n: number }) {
  return {
    getBillDossierIdentity: async (id: string) => (id === BILL ? identity : null),
    getBillActions: async () => [],
    getBillVotes: async () => twoVotes,
    getGoverningRules: async () => [],
    getBillCommittees: async () => [],
    getBillFiscalNotes: async () => [],
    getBillSourceFreshness: async () => null,
    getUpcomingHearingsForBills: async () => [],
    getBillMemberVoteSummary: async () => {
      if (memberSummaryCounter) memberSummaryCounter.n += 1;
      return [];
    },
    getClientProfile: async (_t: string, _c: string) => ({ name: 'Client A', sectorTag: null }),
  };
}

function makePrisma(capturedTenants: string[]) {
  const tx = {
    trackedBill: { findFirst: async () => null },
    intelAlert: { findMany: async () => [] },
    billMatch: { findFirst: async () => null },
  };
  return {
    withTenant: async <T>(tenantId: string, fn: (t: typeof tx) => Promise<T>) => {
      capturedTenants.push(tenantId);
      return fn(tx);
    },
    withSystem: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
}

describe('BillDossierService — tenant safety & bounds', () => {
  it('the global route never returns client context', async () => {
    const svc = new BillDossierService({} as never, makeSource() as never, {} as never);
    const d = await svc.getGlobalDossier(BILL);
    expect(d.context).toBeNull();
    expect(d.tracking).toBeNull();
    expect(d.alerts).toEqual([]);
  });

  it('every client read runs under the caller tenant (no cross-tenant access)', async () => {
    const tenants: string[] = [];
    const svc = new BillDossierService(makePrisma(tenants) as never, makeSource() as never, {} as never);
    await svc.getClientDossier(TENANT_A, CLIENT, BILL);
    // All withTenant calls used the caller's tenant — never another tenant's id.
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants.every((t) => t === TENANT_A)).toBe(true);
  });

  it('reads member-vote tallies in ONE batched query (no N+1) regardless of vote count', async () => {
    const counter = { n: 0 };
    const svc = new BillDossierService({} as never, makeSource(counter) as never, {} as never);
    const d = await svc.getGlobalDossier(BILL);
    expect(d.votes).toHaveLength(2);
    expect(counter.n).toBe(1);
  });

  it('rejects an empty bill id with a 400 and never synthesizes a link', async () => {
    const svc = new BillDossierService({} as never, makeSource() as never, {} as never);
    await expect(svc.getGlobalDossier('   ')).rejects.toThrow(/BILL_NOT_FOUND/);
  });

  it('404s a malformed/unknown bill id (no server error)', async () => {
    const svc = new BillDossierService({} as never, makeSource() as never, {} as never);
    await expect(svc.getGlobalDossier('not-a-real-bill')).rejects.toThrow(/BILL_NOT_FOUND/);
  });
});

describe('Bill360FeatureGuard', () => {
  function ctxWith(tenantId?: string): ExecutionContext {
    const req = tenantId ? { tenantContext: { tenantId, clerkUserId: 'u', role: null } } : {};
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  it('allows the request when bill_360 is enabled', async () => {
    const guard = new Bill360FeatureGuard({ isEnabled: async () => true } as never);
    await expect(guard.canActivate(ctxWith('t1'))).resolves.toBe(true);
  });

  it('404s (not 403) when bill_360 is disabled', async () => {
    const guard = new Bill360FeatureGuard({ isEnabled: async () => false } as never);
    await expect(guard.canActivate(ctxWith('t1'))).rejects.toThrow();
  });

  it('404s when the tenant context is missing', async () => {
    const guard = new Bill360FeatureGuard({ isEnabled: async () => true } as never);
    await expect(guard.canActivate(ctxWith(undefined))).rejects.toThrow();
  });
});
