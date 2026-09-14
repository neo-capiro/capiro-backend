import { PrismaClient } from '@prisma/client';
import { getBill } from '../external/legiscan/legiscan.client.js';
import { refreshResearchBillInventory } from './research-document-hydration.js';
import { currentQuotaMonth } from './legiscan-quota.util.js';
jest.mock('../external/legiscan/legiscan.client.js', () => ({
  getBill: jest.fn(),
  getBillText: jest.fn(),
  getSupportingDocument: jest.fn(),
}));
describe('selected document inventory refresh', () => {
  const p = new PrismaClient(),
    n = 800000000 + Math.floor(Math.random() * 10000000),
    id = 'fl-2024x' + n + '-h1',
    cursor = 'FL-' + n;
  const bill = { id, legiscanBillId: n, legiscanChangeHash: 'retained-revision' };
  const manifest = {
    jurisdiction: 'FL' as const,
    edition: '2026',
    sessionKey: '2024x' + n,
    citations: [],
    billIds: [id],
    hydrateDocuments: true,
    documentBudget: 3,
  };
  const raw = {
    state: 'FL',
    bill_id: n,
    session: { session_id: n },
    change_hash: 'retained-revision',
    texts: [{ doc_id: 42, text_hash: 'text-revision' }],
    amendments: [],
    supplements: [],
  };
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE7_TEST_DATABASE !== 'disposable' ||
      !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)
    )
      throw Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
    await p.$connect();
    await p.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber,description,legiscan_bill_id,legiscan_change_hash,report_source_facts) VALUES(${id},'FL',${manifest.sessionKey},${manifest.sessionKey},'H1','h1','Synthetic inventory','lower','Fixture',${n},'retained-revision','{"preserved":"human/source context"}'::jsonb)`;
    await p.$executeRaw`INSERT INTO state_sync_cursor(id,state,session_id,session_key,queries_used,quota_month) VALUES(${cursor},'FL',${n},${manifest.sessionKey},0,${currentQuotaMonth()})`;
  });
  afterAll(() => p.$disconnect());
  it('retains the exact inventory, preserves other facts and accounts the single provider query', async () => {
    (getBill as jest.Mock).mockResolvedValue(raw);
    const result = await refreshResearchBillInventory(p, 'synthetic', bill, manifest, n, cursor);
    expect(result.expected).toEqual([
      { kind: 'text', providerId: 42, providerHash: 'text-revision' },
    ]);
    const saved = await p.stateBill.findUniqueOrThrow({ where: { id } });
    expect(saved.reportSourceFacts).toMatchObject({
      preserved: 'human/source context',
      documentInventory: result,
    });
    expect((await p.stateSyncCursor.findUniqueOrThrow({ where: { id: cursor } })).queriesUsed).toBe(
      1,
    );
  });
  it('holds changed or incomplete provider revisions without overwriting the retained inventory', async () => {
    const before = (await p.stateBill.findUniqueOrThrow({ where: { id } })).reportSourceFacts;
    (getBill as jest.Mock).mockResolvedValue({ ...raw, change_hash: 'changed' });
    await expect(
      refreshResearchBillInventory(p, 'synthetic', bill, manifest, n, cursor),
    ).rejects.toThrow('CANONICAL_BILL_REVISION_REFRESH_REQUIRED');
    (getBill as jest.Mock).mockResolvedValue({ ...raw, supplements: undefined });
    await expect(
      refreshResearchBillInventory(p, 'synthetic', bill, manifest, n, cursor),
    ).rejects.toThrow('PROVIDER_DOCUMENT_INVENTORY_INCOMPLETE');
    expect((await p.stateBill.findUniqueOrThrow({ where: { id } })).reportSourceFacts).toEqual(
      before,
    );
    expect((await p.stateSyncCursor.findUniqueOrThrow({ where: { id: cursor } })).queriesUsed).toBe(
      3,
    );
  });
  it('fails a concurrent canonical revision change rather than attaching stale inventory', async () => {
    (getBill as jest.Mock).mockImplementation(async () => {
      await p.stateBill.update({ where: { id }, data: { legiscanChangeHash: 'concurrent' } });
      return raw;
    });
    await expect(
      refreshResearchBillInventory(p, 'synthetic', bill, manifest, n, cursor),
    ).rejects.toThrow('CANONICAL_BILL_REVISION_CHANGED_DURING_REFRESH');
    const receipts = await p.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) FROM legal_source_receipt WHERE source='legiscan-research-document-inventory' AND scope->>'billId'=${id}`;
    expect(Number(receipts[0]!.count)).toBe(1);
  });
});
