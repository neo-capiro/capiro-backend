import {
  fetchFederalVersionList,
  loadFederalGeneration,
  finalizeFederalDiscovery,
  enumerateFederalInventories,
  type FederalGeneration,
} from './federal-bill-inventory';
import { federalInventoryManifest } from './federal-billstatus-import';
import { normalizeFederalVersions, FEDERAL_BILL_TYPES } from './federal-billstatus';
import { fetchFederalMetadata } from './federal-bill-metadata';

const version = {
  type: 'Submitted',
  date: '2026-01-01',
  formats: [
    {
      type: 'HTML',
      url: 'https://www.congress.gov/119/crec/2026/01/01/172/1/modified/CREC-2026-01-01-pt1-PgS1.htm',
    },
  ],
};
describe('Congress complete version lists', () => {
  it('paginates exact official amendment paths and retains stable version identities', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        textVersions: [version],
        pagination: {
          count: 2,
          next: 'https://api.congress.gov/v3/amendment/119/samdt/1/text?offset=1',
        },
      })
      .mockResolvedValueOnce({
        textVersions: [{ ...version, type: 'Modified' }],
        pagination: { count: 2 },
      });
    const versions = await fetchFederalVersionList(
      '119-samdt-1',
      'amendment',
      'synthetic-key',
      fetch,
    );
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((v) => v.versionId)).size).toBe(2);
    expect(versions[0]).toMatchObject({ collection: 'AMENDMENTS', versionCode: null });
    expect(fetch.mock.calls[1][0]).toContain('offset=1');
  });
  it('accepts an explicit known-empty list but rejects absent, truncated or moved counts', async () => {
    expect(
      await fetchFederalVersionList('119-samdt-1', 'amendment', 'x', async () => ({
        textVersions: [],
        pagination: { count: 0 },
      })),
    ).toEqual([]);
    for (const response of [
      null,
      { textVersions: [], pagination: { count: 1 } },
      { textVersions: [version], pagination: { count: 0 } },
      {
        textVersions: [version],
        pagination: { count: 2, next: 'https://evil.example/text?offset=1' },
      },
    ])
      await expect(
        fetchFederalVersionList('119-samdt-1', 'amendment', 'x', async () => response),
      ).rejects.toThrow();
  });
});
function generationFixture() {
  const hashes = FEDERAL_BILL_TYPES.map((_, i) => String(i).repeat(64)),
    listHash = 'f'.repeat(64);
  const archives = FEDERAL_BILL_TYPES.map((type, i) => ({
    id: `archive-${type}`,
    source: 'fy26-federal-billstatus-archive',
    complete: true,
    scope: { fiscalYear: 2026, congress: 119, billType: type, archiveHash: hashes[i] },
    manifest: {
      schemaVersion: 1,
      sourceListComplete: true,
      congress: 119,
      billType: type,
      archiveHash: hashes[i],
      inspectedBills: 1,
      billIds: [`119-${type}-1`],
      eligibleBillIds: type === 'hr' ? ['119-hr-1'] : [],
      amendments:
        type === 'hr'
          ? [
              {
                id: '119-samdt-1',
                billId: '119-hr-1',
                amendedAmendmentId: null,
                providerUpdatedAt: '2026-01-01',
                textVersionCount: 1,
              },
            ]
          : [],
    },
  }));
  const proof = {
    id: 'list',
    complete: true,
    scope: { fiscalYear: 2026, congress: 119 },
    manifest: { reportedCount: 1, enumeratedCount: 1, ids: ['119-samdt-1'] },
  };
  const db: any = {
    $queryRawUnsafe: jest.fn(async (sql: string) =>
      sql.includes('fy26-federal-billstatus-archive')
        ? archives
        : sql.includes('fy26-federal-amendment-list')
          ? [proof]
          : [{ id: '119-hr-1' }],
    ),
  };
  return { hashes, listHash, archives, proof, db };
}
describe('federal discovery finalization', () => {
  it('rotates a failed bounded inventory item so the next invocation reaches later amendments', async () => {
    const h = generationFixture(),
      g = await loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1);
    g.amendments.push({ ...g.amendments[0]!, id: '119-samdt-2' });
    let after = '';
    const receipts: any[] = [
      {
        id: 'bill-list',
        source: 'fy26-federal-provider-inventory',
        observedAt: new Date(),
        complete: true,
        scope: {
          fiscalYear: 2026,
          congress: 119,
          billId: '119-hr-1',
          archiveHash: g.billArchives.get('119-hr-1'),
        },
        manifest: federalInventoryManifest({
          kind: 'text',
          providerDocumentId: '119-hr-1',
          providerUpdatedAt: '2026-01-01',
          versions: [],
        }),
      },
    ];
    const db: any = {
      $executeRawUnsafe: jest.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('SET cursor_jsonb')) after = JSON.parse(args[1]).after;
        return 1;
      }),
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) =>
        sql.includes("source='fy26-federal-provider-inventory'")
          ? receipts
          : sql.includes('cursor_jsonb AS cursor')
            ? [{ cursor: { after } }]
            : [{ id: args[0] }],
      ),
    };
    const fetch = jest.fn(async (url: string) => {
      if (url.includes('/samdt/1/')) throw Error('synthetic provider failure');
      return { textVersions: [], pagination: { count: 0 } };
    });
    expect(
      await enumerateFederalInventories(db, g, { limit: 1, apiKey: 'x', fetchJson: fetch }),
    ).toMatchObject({ processed: 1, failed: 1, complete: false });
    expect(after).toBe('amendment:119-samdt-1');
    expect(
      await enumerateFederalInventories(db, g, { limit: 1, apiKey: 'x', fetchJson: fetch }),
    ).toMatchObject({ processed: 1, failed: 0 });
    expect(fetch.mock.calls[1]![0]).toContain('/samdt/2/');
  });
  it('binds all eight archives to exact audited amendment IDs and current eligible parents', async () => {
    const h = generationFixture(),
      g = await loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1);
    expect(g.billIds).toEqual(['119-hr-1']);
    expect(g.amendments).toHaveLength(1);
    expect(g.amendmentListReceiptId).toBe('list');
    h.proof.manifest.ids = ['119-samdt-2'];
    await expect(loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1)).rejects.toThrow(
      'EXACT_ENUMERATION_MISMATCH',
    );
  });
  it('rejects unresolved or cyclic nested amendment parents', async () => {
    const h = generationFixture();
    h.archives[0]!.manifest.amendments[0]!.amendedAmendmentId = '119-samdt-1' as any;
    await expect(loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1)).rejects.toThrow(
      'PARENT_UNRESOLVED',
    );
  });
  it('cannot declare complete with a missing amendment list, and pins actual child receipt IDs', async () => {
    const h = generationFixture(),
      g = await loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1);
    const receipts: any[] = [
      {
        id: 'bill-list',
        source: 'fy26-federal-provider-inventory',
        observedAt: new Date(),
        complete: true,
        scope: {
          fiscalYear: 2026,
          congress: 119,
          billId: '119-hr-1',
          archiveHash: g.billArchives.get('119-hr-1'),
        },
        manifest: federalInventoryManifest({
          kind: 'text',
          providerDocumentId: '119-hr-1',
          providerUpdatedAt: '2026-01-01',
          versions: [],
        }),
      },
    ];
    const db: any = {
      $executeRawUnsafe: jest.fn(async () => 1),
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) =>
        sql.includes("source='fy26-federal-provider-inventory'") ? receipts : [{ id: args[0] }],
      ),
    };
    await expect(finalizeFederalDiscovery(db, g)).rejects.toThrow('CHILD_INVENTORY_INCOMPLETE');
    receipts.push({
      id: 'amendment-list',
      source: 'fy26-federal-provider-inventory',
      observedAt: new Date(),
      complete: true,
      scope: {
        fiscalYear: 2026,
        congress: 119,
        billId: '119-hr-1',
        inventoryHash: g.inventoryHash,
      },
      manifest: federalInventoryManifest({
        kind: 'amendment',
        providerDocumentId: '119-samdt-1',
        providerUpdatedAt: '2026-01-01',
        versions: normalizeFederalVersions('119-samdt-1', 'amendment', [version]),
      }),
    });
    expect(await finalizeFederalDiscovery(db, g)).toMatchObject({ complete: true, inventories: 2 });
    expect(JSON.parse(db.$executeRawUnsafe.mock.calls[0][4]).requiredInventoryReceiptIds).toEqual([
      'amendment-list',
      'bill-list',
    ]);
  });
});
describe('targeted federal metadata refresh', () => {
  const bill = { congress: 119, type: 'HR', number: '1', updateDate: '2026-02-01T00:00:00Z' };
  it('checks timestamp around authoritative empty subresources', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ bill })
      .mockResolvedValueOnce({ subjects: { legislativeSubjects: [] }, pagination: { count: 0 } })
      .mockResolvedValueOnce({
        cosponsors: [],
        pagination: { count: 0, countIncludingWithdrawnCosponsors: 0 },
      })
      .mockResolvedValueOnce({ bill });
    expect(await fetchFederalMetadata('119-hr-1', 'x', fetch)).toMatchObject({
      subjects: [],
      cosponsors: [],
      metadataUpdatedAt: bill.updateDate,
    });
  });
  it('does not replace data after a truncated roster or a changed update timestamp', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ bill })
      .mockResolvedValueOnce({ subjects: { legislativeSubjects: [] }, pagination: { count: 0 } })
      .mockResolvedValueOnce({
        cosponsors: [],
        pagination: { countIncludingWithdrawnCosponsors: 1 },
      });
    await expect(fetchFederalMetadata('119-hr-1', 'x', fetch)).rejects.toThrow('TRUNCATED');
    const changed = jest
      .fn()
      .mockResolvedValueOnce({ bill })
      .mockResolvedValueOnce({ subjects: { legislativeSubjects: [] } })
      .mockResolvedValueOnce({ cosponsors: [], pagination: { count: 0 } })
      .mockResolvedValueOnce({ bill: { ...bill, updateDate: '2026-02-02T00:00:00Z' } });
    await expect(fetchFederalMetadata('119-hr-1', 'x', changed)).rejects.toThrow(
      'CHANGED_DURING_FETCH',
    );
  });
});
