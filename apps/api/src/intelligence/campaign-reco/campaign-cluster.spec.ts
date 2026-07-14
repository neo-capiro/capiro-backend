import {
  buildCampaignClusters,
  splitClustersByTenant,
  isClusterMaterial,
  type IntelChangeRow,
} from './campaign-cluster.js';

const row = (over: Partial<IntelChangeRow>): IntelChangeRow => ({
  id: 'c1',
  source: 'congress_bill',
  changeType: 'bill_action',
  severity: 'notable',
  title: 'T',
  description: 'D',
  relatedClientIds: [],
  relatedPeCodes: [],
  relatedIssues: [],
  billId: null,
  ...over,
});

describe('buildCampaignClusters', () => {
  it('groups changes that share a bill and unions their clients', () => {
    const clusters = buildCampaignClusters([
      row({ id: 'a', billId: 'hr-8800-119', relatedClientIds: ['cl1'] }),
      row({ id: 'b', billId: 'hr-8800-119', relatedClientIds: ['cl2', 'cl1'] }),
    ]);
    const bill = clusters.find((c) => c.key === 'bill:hr-8800-119')!;
    expect(bill.clientIds.sort()).toEqual(['cl1', 'cl2']);
    expect(bill.changeIds.sort()).toEqual(['a', 'b']);
  });
  it('a change joins a cluster per PE and per issue', () => {
    const clusters = buildCampaignClusters([
      row({ id: 'a', relatedPeCodes: ['0603851F'], relatedIssues: ['DEF'] }),
    ]);
    expect(clusters.map((c) => c.key).sort()).toEqual(['issue:DEF', 'pe:0603851F']);
  });
});

describe('isClusterMaterial (SC 5.3.3 selectivity)', () => {
  it('critical is material; a single notable is NOT; two notables are', () => {
    const crit = buildCampaignClusters([
      row({ billId: 'b', severity: 'critical', relatedClientIds: ['x'] }),
    ])[0]!;
    expect(isClusterMaterial(crit)).toBe(true);
    const oneNotable = buildCampaignClusters([
      row({ id: 'a', billId: 'b', severity: 'notable' }),
    ])[0]!;
    expect(isClusterMaterial(oneNotable)).toBe(false);
    const twoNotable = buildCampaignClusters([
      row({ id: 'a', billId: 'b', severity: 'notable' }),
      row({ id: 'c', billId: 'b', severity: 'notable' }),
    ])[0]!;
    expect(isClusterMaterial(twoNotable)).toBe(true);
  });
});

describe('splitClustersByTenant — TENANT ISOLATION GUARD', () => {
  const clusters = buildCampaignClusters([
    row({ billId: 'hr-1', severity: 'critical', relatedClientIds: ['t1a', 't1b', 't2a'] }),
  ]);
  const clientTenant = new Map([
    ['t1a', { tenantId: 'T1', name: 'Alpha', active: true }],
    ['t1b', { tenantId: 'T1', name: 'Beta', active: true }],
    ['t2a', { tenantId: 'T2', name: 'Gamma', active: true }],
  ]);

  it('NEVER mixes clients across tenants — each entry has only its own tenant clients', () => {
    const per = splitClustersByTenant(clusters, clientTenant, 2);
    // T1 has 2 clients in the cluster → one entry with ONLY Alpha+Beta; T2 has 1 → dropped.
    expect(per).toHaveLength(1);
    expect(per[0]!.tenantId).toBe('T1');
    expect(per[0]!.clientNames.sort()).toEqual(['Alpha', 'Beta']);
    expect(per[0]!.clientIds).not.toContain('t2a');
  });
  it('drops inactive clients and clusters below the min-client threshold', () => {
    const withInactive = new Map(clientTenant);
    withInactive.set('t1b', { tenantId: 'T1', name: 'Beta', active: false });
    // T1 now has only 1 ACTIVE client in the cluster → below min 2 → no entry.
    expect(splitClustersByTenant(clusters, withInactive, 2)).toHaveLength(0);
  });
  it('drops a client with no known tenant (never leaks an unresolved id)', () => {
    const partial = new Map([
      ['t1a', { tenantId: 'T1', name: 'Alpha', active: true }],
      ['t1b', { tenantId: 'T1', name: 'Beta', active: true }],
    ]);
    const per = splitClustersByTenant(clusters, partial, 2);
    expect(per).toHaveLength(1);
    expect(per[0]!.clientIds.sort()).toEqual(['t1a', 't1b']);
  });
});

describe('asSeverity vocab normalization (§5.3 — state + federal writers)', () => {
  it('state high => critical (material); a single medium => notable (not); two medium => material', () => {
    const high = buildCampaignClusters([
      row({ billId: 'b', severity: 'high', relatedClientIds: ['x'] }),
    ])[0]!;
    expect(isClusterMaterial(high)).toBe(true);
    const oneMed = buildCampaignClusters([row({ id: 'a', billId: 'b', severity: 'medium' })])[0]!;
    expect(isClusterMaterial(oneMed)).toBe(false);
    const twoMed = buildCampaignClusters([
      row({ id: 'a', billId: 'b', severity: 'medium' }),
      row({ id: 'c', billId: 'b', severity: 'medium' }),
    ])[0]!;
    expect(isClusterMaterial(twoMed)).toBe(true);
  });
});

describe('splitClustersByTenant — evidence/changeIds are TENANT-SCOPED', () => {
  const clusters = buildCampaignClusters([
    row({
      id: 'ca',
      billId: 'hr-1',
      severity: 'critical',
      title: 'T1BILL',
      relatedClientIds: ['t1a', 't1b'],
    }),
    row({
      id: 'cb',
      billId: 'hr-1',
      severity: 'critical',
      title: 'T2BILL',
      relatedClientIds: ['t2a', 't2b'],
    }),
  ]);
  const clientTenant = new Map([
    ['t1a', { tenantId: 'T1', name: 'Alpha', active: true }],
    ['t1b', { tenantId: 'T1', name: 'Beta', active: true }],
    ['t2a', { tenantId: 'T2', name: 'Gamma', active: true }],
    ['t2b', { tenantId: 'T2', name: 'Delta', active: true }],
  ]);

  it("a tenant entry never carries another tenant's changeIds or evidence", () => {
    const per = splitClustersByTenant(clusters, clientTenant, 2);
    const t1 = per.find((e) => e.tenantId === 'T1')!;
    const t2 = per.find((e) => e.tenantId === 'T2')!;
    // Global cluster.changeIds is the cross-tenant union [ca, cb]...
    expect(t1.cluster.changeIds.sort()).toEqual(['ca', 'cb']);
    // ...but each tenant's SCOPED changeIds/evidence carry only its own change.
    expect(t1.changeIds).toEqual(['ca']);
    expect(t1.evidence.map((e) => e.title)).toEqual(['T1BILL']);
    expect(t2.changeIds).toEqual(['cb']);
    expect(t2.evidence.map((e) => e.title)).toEqual(['T2BILL']);
  });
});
