import { walk } from '../../../scripts/sync-tango-funding.js';
import { FundingCatalogStore } from './funding-catalog.store.js';

/**
 * A provider opportunity family can legitimately arrive without a SAM URL and
 * without either latest-notice identifier. That is an unresolved identity, not
 * a malformed one: the page must keep its full snapshot and must not guess a
 * canonical notice. These tests pin that behaviour against a fake Prisma client
 * so no live database or provider call is involved.
 */
const key = (c: string) => c.repeat(32);

function harness(options: { localNoticeId?: string; snapshotFailsFor?: string } = {}) {
  const snapshots: any[] = [];
  const tx = {
    tangoResourceSnapshot: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      create: jest.fn(async ({ data }: any) => {
        if (options.snapshotFailsFor === data.externalId) throw new Error('snapshot write failed');
        snapshots.push(data);
        return { id: `snapshot-${snapshots.length}`, version: 1 };
      }),
    },
  };
  const prisma: any = {
    $transaction: jest.fn(async (run: any) => run(tx)),
    $queryRaw: jest.fn(async () => (options.localNoticeId ? [{ id: options.localNoticeId }] : [])),
    samOpportunity: { findUnique: jest.fn(async () => (options.localNoticeId ? { id: options.localNoticeId } : null)),
      update: jest.fn(async () => ({})) },
    tangoOpportunityNotice: { upsert: jest.fn(async () => ({})) },
    opportunityAttachment: { findFirst: jest.fn(async () => null), update: jest.fn(async () => ({})), create: jest.fn(async () => ({})) },
  };
  const store = new FundingCatalogStore(prisma);
  jest.spyOn(store.observations, 'proposeLink').mockResolvedValue({} as any);
  return { prisma, store, tx, snapshots };
}

/** Minimal WalkDeps: one provider page envelope plus the real store writer. */
function deps(store: FundingCatalogStore, rows: any[], next: string | null = null) {
  return {
    read: jest.fn(async () => null),
    page: jest.fn(async () => ({ count: rows.length, results: rows, next })),
    write: (row: any) => store.opportunity(row, true),
    checkpoint: jest.fn(async () => undefined),
  };
}

describe('Tango funding catalog opportunity identity', () => {
  test('an absent SAM URL and absent latest IDs keep the snapshot and mutate nothing canonical', async () => {
    const h = harness();
    const payload = { opportunity_id: 'family-alpha', description: 'Family record without notice identity',
      notice_history: [{ notice_id: key('a'), title: 'History entry' }], attachments: [] };

    await expect(h.store.opportunity(payload, true)).resolves.toBeUndefined();

    expect(h.tx.tangoResourceSnapshot.create).toHaveBeenCalledTimes(1);
    const snapshot = h.snapshots[0];
    expect(snapshot).toMatchObject({ resourceType: 'opportunity', externalId: 'family-alpha' });
    expect(snapshot.sourceUrl ?? null).toBeNull();
    expect(snapshot.normalizedJsonb).toEqual(payload);
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.prisma.samOpportunity.update).not.toHaveBeenCalled();
    expect(h.prisma.tangoOpportunityNotice.upsert).not.toHaveBeenCalled();
    expect(h.prisma.opportunityAttachment.create).not.toHaveBeenCalled();
    expect(h.prisma.opportunityAttachment.update).not.toHaveBeenCalled();
    expect(h.store.observations.proposeLink).not.toHaveBeenCalled();
  });

  test('the walker advances a mixed identified/unresolved page after the snapshots persist', async () => {
    const h = harness({ localNoticeId: 'local-1' });
    const identified = { opportunity_id: 'family-beta', latest_notice_id: key('b'), description: 'Identified family' };
    const unresolved = { opportunity_id: 'family-gamma', sam_url: null, latest_notice: { notice_id: null } };
    const d = deps(h.store, [identified, unresolved]);

    await expect(walk(d, { commit: true, maxPages: 1, incremental: false }))
      .resolves.toEqual({ processed: 2, complete: true });

    expect(h.snapshots.map(s => s.externalId).sort()).toEqual(['family-beta', 'family-gamma']);
    expect(h.snapshots.find(s => s.externalId === 'family-gamma').sourceUrl ?? null).toBeNull();
    expect(h.prisma.samOpportunity.update).toHaveBeenCalledTimes(1);
    expect(d.checkpoint).toHaveBeenCalledTimes(1);
    expect(d.checkpoint.mock.calls[0][0]).toBeNull();
    expect(d.checkpoint.mock.calls[0][3]).toBe(2);
  });

  test('a SAM URL alone still resolves the canonical notice', async () => {
    const h = harness({ localNoticeId: 'local-2' });
    await h.store.opportunity({ opportunity_id: 'family-delta', description: 'Identified through its SAM URL',
      sam_url: `https://sam.gov/opp/${key('c')}/view` }, true);
    expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.snapshots[0].sourceUrl).toBe(`https://sam.gov/opp/${key('c')}/view`);
    expect(h.prisma.samOpportunity.update).toHaveBeenCalledTimes(1);
  });

  test('a snapshot persistence failure keeps the page pending', async () => {
    const h = harness({ localNoticeId: 'local-3', snapshotFailsFor: 'family-epsilon' });
    const d = deps(h.store, [
      { opportunity_id: 'family-epsilon', latest_notice_id: key('d'), description: 'Fails to snapshot' },
      { opportunity_id: 'family-rho', sam_url: null },
    ]);

    await expect(walk(d, { commit: true, maxPages: 2, incremental: false })).rejects.toThrow('snapshot write failed');

    expect(d.checkpoint).not.toHaveBeenCalled();
    expect(h.prisma.samOpportunity.update).not.toHaveBeenCalled();
    expect(h.prisma.tangoOpportunityNotice.upsert).not.toHaveBeenCalled();
    expect(h.prisma.opportunityAttachment.create).not.toHaveBeenCalled();
  });

  test('malformed supplied identities still fail', async () => {
    const h = harness({ localNoticeId: 'local-4' });
    await expect(h.store.opportunity({ opportunity_id: 'family-zeta', latest_notice_id: 'FA-2026-123' }, true))
      .rejects.toThrow('Invalid government notice identifier');
    await expect(h.store.opportunity({ opportunity_id: 'family-eta', sam_url: `https://sam.gov.attacker.test/opp/${key('d')}/view` }, true))
      .rejects.toThrow('Invalid SAM source URL');
    await expect(h.store.opportunity({ opportunity_id: 'family-theta', latest_notice_id: 'not-a-hex-id' }, true))
      .rejects.toThrow('Invalid government notice identifier');
    await expect(h.store.opportunity({ opportunity_id: 'family-kappa', latest_notice_id: 0 }, true))
      .rejects.toThrow('Invalid government notice identifier');
    await expect(h.store.opportunity({ opportunity_id: 'family-lambda', latest_notice_id: false }, true))
      .rejects.toThrow('Invalid government notice identifier');
    await expect(h.store.opportunity({ opportunity_id: 'family-mu', latest_notice: { notice_id: 0 } }, true))
      .rejects.toThrow('Invalid government notice identifier');
    await expect(h.store.opportunity({ opportunity_id: 'family-nu', sam_url: 0 }, true))
      .rejects.toThrow('Invalid SAM source URL');
    await expect(h.store.opportunity({ opportunity_id: 'family-xi', sam_url: false }, true))
      .rejects.toThrow('Invalid SAM source URL');
    await expect(h.store.opportunity({ opportunity_id: 'family-omicron',
      sam_url: { url: `https://sam.gov/opp/${key('f')}/view` } }, true)).rejects.toThrow('Invalid SAM source URL');
    expect(h.tx.tangoResourceSnapshot.create).not.toHaveBeenCalled();
  });

  test('conflicting explicit and nested latest IDs still fail', async () => {
    const h = harness({ localNoticeId: 'local-5' });
    await expect(h.store.opportunity({ opportunity_id: 'family-iota', latest_notice_id: key('e'),
      latest_notice: { notice_id: key('f') } }, true)).rejects.toThrow('Conflicting latest notice IDs');
    expect(h.tx.tangoResourceSnapshot.create).not.toHaveBeenCalled();
  });

  test('a missing family identity is still rejected', async () => {
    const h = harness();
    await expect(h.store.opportunity({ latest_notice_id: key('e') }, true))
      .rejects.toThrow('Missing provider opportunity identity');
  });
});
