import { federalInventoryReuse } from './federal-inventory-reuse';
import { federalInventoryManifest } from './federal-billstatus-import';
import { normalizeFederalVersions } from './federal-billstatus';
import type { FederalGeneration } from './federal-bill-inventory';
const binding = {
  id: '119-samdt-1',
  billId: '119-hr-1',
  amendedAmendmentId: null,
  providerUpdatedAt: '2026-01-01T00:00:00Z',
  textVersionCount: 1,
};
const versions = normalizeFederalVersions(binding.id, 'amendment', [
  {
    type: 'Submitted',
    date: '2026-01-01',
    formats: [
      {
        url: 'https://www.congress.gov/119/crec/2026/01/01/172/1/modified/CREC-2026-01-01-pt1-PgS1.htm',
      },
    ],
  },
]);
function fixture() {
  const previous = { ...binding },
    receipt: any = {
      id: 'old-inventory',
      scope: { fiscalYear: 2026, congress: 119, billId: binding.billId },
      complete: true,
      manifest: federalInventoryManifest({
        kind: 'amendment',
        providerDocumentId: binding.id,
        providerUpdatedAt: binding.providerUpdatedAt,
        versions,
      }),
    };
  const db: any = {
    $executeRawUnsafe: jest.fn(async () => 1),
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) =>
      sql.includes("source='fy26-federal-discovery'")
        ? [
            {
              id: 'old-discovery',
              manifest: {
                billIds: [binding.billId],
                archiveReceiptIds: ['old-archive'],
                requiredInventoryReceiptIds: ['old-inventory'],
              },
            },
          ]
        : sql.includes("source='fy26-federal-billstatus-archive'")
          ? [{ manifest: { amendments: [previous] } }]
          : sql.includes("source='fy26-federal-provider-inventory'")
            ? [receipt]
            : [{ id: args[0] }],
    ),
  };
  const generation = { congress: 119, amendments: [{ ...binding }] } as FederalGeneration;
  const task = {
    kind: 'amendment' as const,
    id: binding.id,
    billId: binding.billId,
    updated: binding.providerUpdatedAt,
  };
  return { db, previous, receipt, generation, task };
}
describe('unchanged amendment inventory reuse', () => {
  it('binds a verified prior immutable list to the new generation without a provider request', async () => {
    const h = fixture(),
      reuse = await federalInventoryReuse(h.db, h.generation);
    expect(
      await reuse(h.task, {
        fiscalYear: 2026,
        congress: 119,
        billId: binding.billId,
        inventoryHash: 'new-generation',
        refreshId: 'new-cycle',
      }),
    ).toBe(true);
    const args = h.db.$executeRawUnsafe.mock.calls[0];
    expect(JSON.parse(args[3])).toMatchObject({
      inventoryHash: 'new-generation',
      refreshId: 'new-cycle',
    });
    expect(JSON.parse(args[4])).toMatchObject({ reusedReceiptId: 'old-inventory', versions });
  });
  it.each(['timestamp', 'parent', 'nestedParent', 'count', 'malformed'] as const)(
    'requires unchanged %s proof before reusing any list',
    async (change) => {
      const h = fixture();
      if (change === 'timestamp')
        h.generation.amendments[0]!.providerUpdatedAt = '2026-02-01T00:00:00Z';
      if (change === 'parent') h.previous.billId = '119-s-1';
      if (change === 'nestedParent') h.previous.amendedAmendmentId = '119-samdt-2' as any;
      if (change === 'count') h.previous.textVersionCount = 2;
      if (change === 'malformed') h.receipt.manifest.enumeratedCount = 0;
      expect(await (await federalInventoryReuse(h.db, h.generation))(h.task, {})).toBe(false);
      expect(h.db.$executeRawUnsafe).not.toHaveBeenCalled();
    },
  );
});
