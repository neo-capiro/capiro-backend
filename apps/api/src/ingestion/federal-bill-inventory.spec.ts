import {
  fetchFederalVersionList,
  loadFederalGeneration,
  finalizeFederalDiscovery,
  enumerateFederalInventories,
  selectFederalInventories,
  type FederalGeneration,
} from './federal-bill-inventory';
import { federalInventoryManifest, writeFederalInventory } from './federal-billstatus-import';
import { normalizeFederalVersions, FEDERAL_BILL_TYPES, federalHash } from './federal-billstatus';
import { parseFederalBillInventory } from './federal-bill-inventory-read';
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
  it('retains Congress public-law package identity through the complete inventory receipt', async () => {
    const base = 'https://www.congress.gov/119/plaws/publ131/PLAW-119publ131';
    const payload = {
      pagination: { count: 1 },
      textVersions: [
        {
          type: 'Public Law',
          date: '2026-10-21T03:59:59Z',
          formats: ['.htm', '.pdf', '_uslm.xml'].map((suffix) => ({ url: base + suffix })),
        },
      ],
    };
    const fetch = jest.fn(async () => payload);
    const list = await fetchFederalVersionList('119-hr-4307', 'text', 'synthetic-key', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    const manifest = federalInventoryManifest({
      kind: 'text',
      providerDocumentId: '119-hr-4307',
      providerUpdatedAt: null,
      ...list,
    });
    const versions = parseFederalBillInventory(
      {
        id: 'synthetic-receipt',
        scope: { fiscalYear: 2026, congress: 119, billId: '119-hr-4307' },
        manifest,
        complete: true,
        observedAt: '2026-11-02',
      },
      {
        receiptId: 'synthetic-discovery',
        congress: 119,
        billIds: ['119-hr-4307'],
        requiredInventoryReceiptIds: ['synthetic-receipt'],
        observedAt: '2026-11-02',
      },
    );
    expect(versions).toHaveLength(1);
    expect(versions![0]).toMatchObject({
      billId: '119-hr-4307',
      collection: 'PLAW',
      packageId: 'PLAW-119publ131',
      sourceUrls: expect.arrayContaining([base + '.htm', base + '.pdf', base + '_uslm.xml']),
    });
    expect(versions![0]!.sourceUrls).toHaveLength(3);
    await expect(
      fetchFederalVersionList('119-hr-4307', 'text', 'synthetic-key', async () => ({
        ...payload,
        pagination: { count: 2 },
      })),
    ).rejects.toThrow('FEDERAL_API_TEXT_LIST_INCOMPLETE');
  });

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
    const { versions } = await fetchFederalVersionList(
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
    ).toEqual({ versions: [] });
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

  it('retains and replays exact single-page duplicate evidence without inflating distinct coverage', async () => {
    const payload = { pagination: { count: 2 }, textVersions: [version, structuredClone(version)] };
    const fetch = jest.fn(async () => payload);
    const list = await fetchFederalVersionList(
      '119-samdt-1',
      'amendment',
      'synthetic-secret',
      fetch,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    // Bulk and other callers have no single-page proof and keep the strict guard.
    expect(() =>
      normalizeFederalVersions('119-samdt-1', 'amendment', payload.textVersions),
    ).toThrow('FEDERAL_DUPLICATE_VERSION');
    expect(list.versions).toEqual(normalizeFederalVersions('119-samdt-1', 'amendment', [version]));
    expect(list.exactDuplicateProof).toMatchObject({
      sourceUrl: 'https://api.congress.gov/v3/amendment/119/samdt/1/text',
      offset: 0,
      pageCount: 1,
    });
    expect(JSON.parse(list.exactDuplicateProof!.pageJson)).toEqual(payload);
    expect(list.exactDuplicateProof!.pageSha256).toBe(
      federalHash(list.exactDuplicateProof!.pageJson),
    );
    const input = {
      kind: 'amendment' as const,
      providerDocumentId: '119-samdt-1',
      providerUpdatedAt: null,
      ...list,
    };
    const manifest = federalInventoryManifest(input);
    expect(manifest).toMatchObject({
      reportedCount: 2,
      enumeratedCount: 2,
      distinctVersionCount: 1,
      exactDuplicateCount: 1,
    });
    const scope = {
      fiscalYear: 2026,
      congress: 119,
      billId: '119-hr-1',
      inventoryHash: 'a'.repeat(64),
    };
    const receipt = {
      id: 'synthetic-receipt',
      scope,
      manifest,
      complete: true,
      observedAt: '2026-01-01',
    };
    const discovery = {
      receiptId: 'synthetic-discovery',
      congress: 119,
      billIds: ['119-hr-1'],
      requiredInventoryReceiptIds: [receipt.id],
      observedAt: '2026-01-01',
    };
    expect(parseFederalBillInventory(receipt, discovery)).toHaveLength(1);
    // JSONB may reorder object keys; the retained exact JSON string remains byte-stable.
    const reorder = (value: any): any =>
      Array.isArray(value)
        ? value.map(reorder)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, reorder(value[key])]),
            )
          : value;
    expect(parseFederalBillInventory(reorder(receipt), discovery)).toEqual(
      parseFederalBillInventory(receipt, discovery),
    );
    const db: any = {
      $executeRawUnsafe: jest.fn(async () => 1),
      $queryRawUnsafe: jest.fn(async (_sql: string, id: string) => [{ id }]),
    };
    const firstId = await writeFederalInventory(db, scope, input, true);
    expect(await writeFederalInventory(db, scope, input, true)).toBe(firstId);
    const stored = JSON.parse(db.$executeRawUnsafe.mock.calls[0][4]);
    expect(stored).toEqual(manifest);
    expect(JSON.stringify(stored)).not.toContain('synthetic-secret');
    expect(db.$executeRawUnsafe.mock.calls[0][5]).toBe(true);
    for (const change of [
      { exactDuplicateProof: undefined },
      { reportedCount: 1, enumeratedCount: 1 },
      { distinctVersionCount: 2 },
      { exactDuplicateCount: 0 },
      { versions: [{ ...list.versions[0], type: 'Changed' }] },
      { exactDuplicateProof: { ...list.exactDuplicateProof, pageCount: 2 } },
      {
        exactDuplicateProof: {
          ...list.exactDuplicateProof,
          sourceUrl: 'https://api.congress.gov/v3/amendment/119/samdt/2/text',
        },
      },
      { exactDuplicateProof: { ...list.exactDuplicateProof, pageSha256: '0'.repeat(64) } },
    ])
      expect(
        parseFederalBillInventory({ ...receipt, manifest: { ...manifest, ...change } }, discovery),
      ).toBeNull();
    expect(() => federalInventoryManifest({ ...input, versions: [] })).toThrow(
      'FEDERAL_DUPLICATE_PROOF_VERSION_MISMATCH',
    );
  });

  it.each([
    { ...version, extraProviderField: 'different' },
    { ...version, type: ' Submitted ' },
    { ...version, formats: [{ ...version.formats[0], type: 'Different label' }] },
    { ...version, formats: [...version.formats, ...version.formats] },
  ])(
    'keeps nonidentical raw entries with colliding normalized identities closed: %j',
    async (other) => {
      await expect(
        fetchFederalVersionList('119-samdt-1', 'amendment', 'x', async () => ({
          textVersions: [version, structuredClone(version), other],
          pagination: { count: 3 },
        })),
      ).rejects.toThrow('FEDERAL_DUPLICATE_VERSION');
    },
  );

  it('rejects identical duplicates across pages and within a page of a multipage inventory', async () => {
    for (const first of [[version], [version, version]]) {
      const fetch = jest
        .fn()
        .mockResolvedValueOnce({
          textVersions: first,
          pagination: {
            count: first.length + 1,
            next: `https://api.congress.gov/v3/amendment/119/samdt/1/text?offset=${first.length}`,
          },
        })
        .mockResolvedValueOnce({
          textVersions: [version],
          pagination: { count: first.length + 1 },
        });
      await expect(fetchFederalVersionList('119-samdt-1', 'amendment', 'x', fetch)).rejects.toThrow(
        'FEDERAL_DUPLICATE_VERSION',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    }
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
  it('allows historical generations alongside new canonical parents but refuses missing old members', async () => {
    const h = generationFixture(),
      original = h.db.$queryRawUnsafe.getMockImplementation()!;
    h.db.$queryRawUnsafe.mockImplementation(async (sql: string, ...args: any[]) =>
      sql.includes('FROM congress_bill')
        ? [{ id: '119-hr-1' }, { id: '119-hr-2' }]
        : original(sql, ...args),
    );
    expect((await loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1)).billIds).toEqual([
      '119-hr-1',
    ]);
    h.db.$queryRawUnsafe.mockImplementation(async (sql: string, ...args: any[]) =>
      sql.includes('FROM congress_bill') ? [{ id: '119-hr-2' }] : original(sql, ...args),
    );
    await expect(loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1)).rejects.toThrow(
      'ADMISSION_MISMATCH',
    );
  });
  it('requires current amendment source timestamps when the fresh list supplies them', async () => {
    const h = generationFixture();
    (h.proof.manifest as any).memberUpdates = { '119-samdt-1': '2026-02-01' };
    await expect(loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1, false)).rejects.toThrow(
      'SOURCE_MOVED',
    );
  });
  it('never lets an older complete receipt override this refresh cycle held inventory', async () => {
    const h = generationFixture(),
      g = await loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1, true, 'new-cycle');
    const common = {
      source: 'fy26-federal-provider-inventory',
      observedAt: new Date(),
      scope: {
        fiscalYear: 2026,
        congress: 119,
        billId: '119-hr-1',
        archiveHash: g.billArchives.get('119-hr-1'),
      },
      manifest: { kind: 'text', providerDocumentId: '119-hr-1' },
    };
    const old = { ...common, id: 'old', complete: true },
      held = {
        ...common,
        id: 'held',
        complete: false,
        scope: { ...common.scope, refreshId: 'new-cycle' },
      };
    expect(selectFederalInventories([old, held], g).get('text:119-hr-1')).toBe(held);
    expect(selectFederalInventories([old], g).size).toBe(0);
  });
  it('fetches changed held versions once while unchanged complete bulk versions require no enumeration request', async () => {
    const h = generationFixture(),
      g = await loadFederalGeneration(h.db, h.hashes, h.listHash, 119, 1, true, 'cycle');
    g.amendments = [];
    const scope = {
      fiscalYear: 2026,
      congress: 119,
      billId: '119-hr-1',
      archiveHash: g.billArchives.get('119-hr-1'),
      refreshId: 'cycle',
    };
    const receipts: any[] = [
      {
        id: 'held',
        source: 'fy26-federal-provider-inventory',
        complete: false,
        scope,
        manifest: federalInventoryManifest({
          kind: 'text',
          providerDocumentId: '119-hr-1',
          providerUpdatedAt: '2026-02-01',
          versions: [],
        }),
        observedAt: new Date(),
      },
    ];
    const db: any = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) =>
        sql.includes("source='fy26-federal-provider-inventory'")
          ? receipts
          : sql.includes('cursor_jsonb AS cursor')
            ? [{ cursor: { after: '' } }]
            : [{ id: args[0] }],
      ),
      $executeRawUnsafe: jest.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO legal_source_receipt'))
          receipts.unshift({
            id: args[0],
            source: args[1],
            scope: JSON.parse(args[2]),
            manifest: JSON.parse(args[3]),
            complete: args[4],
            observedAt: new Date(),
          });
        return 1;
      }),
    };
    const published = {
      type: 'Reported',
      date: '2026-02-01',
      formats: [
        { url: 'https://www.govinfo.gov/content/pkg/BILLS-119hr1rh/xml/BILLS-119hr1rh.xml' },
      ],
    };
    const fetch = jest.fn(async () => ({ textVersions: [published], pagination: { count: 1 } }));
    expect(
      await enumerateFederalInventories(db, g, { limit: 1, apiKey: 'synthetic', fetchJson: fetch }),
    ).toMatchObject({ processed: 1, complete: true });
    expect(receipts[0].manifest.versions).toEqual(
      normalizeFederalVersions('119-hr-1', 'text', [published]),
    );
    expect(receipts[0].scope.refreshId).toBe('cycle');
    expect(
      await enumerateFederalInventories(db, g, { limit: 1, apiKey: 'synthetic', fetchJson: fetch }),
    ).toMatchObject({ processed: 0, complete: true });
    expect(fetch).toHaveBeenCalledTimes(1);
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
        sql.includes("source='fy26-federal-provider-inventory'")
          ? receipts
          : sql.includes('FROM congress_bill')
            ? [{ id: '119-hr-1' }]
            : [{ id: args[0] }],
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
    db.$queryRawUnsafe.mockImplementation(async (sql: string, ...args: any[]) =>
      sql.includes("source='fy26-federal-provider-inventory'")
        ? receipts
        : sql.includes('FROM congress_bill')
          ? [{ id: '119-hr-1' }, { id: '119-hr-2' }]
          : [{ id: args[0] }],
    );
    db.$executeRawUnsafe.mockClear();
    await expect(finalizeFederalDiscovery(db, g)).rejects.toThrow('CANONICAL_ADMISSION_MISMATCH');
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
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
