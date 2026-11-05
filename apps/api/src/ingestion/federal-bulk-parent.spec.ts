import { persistFederalBulkParent } from './federal-bulk-parent';
import { parseFederalBillStatusXml } from './federal-billstatus';

const bill = () =>
  parseFederalBillStatusXml(
    `<billStatus><bill><congress>119</congress><type>HR</type><number>1</number><title>Synthetic parent</title><introducedDate>2026-01-01</introducedDate><updateDate>2026-02-01T00:00:00Z</updateDate><updateDateIncludingText>2026-02-02T00:00:00Z</updateDateIncludingText><actions><item><actionDate>2026-01-01</actionDate><text>Introduced</text></item></actions></bill></billStatus>`,
    { congress: 119, billType: 'hr' },
  );
function fixture(current: any = null, reuse = false) {
  const db: any = {
    congressBill: {
      findUnique: jest.fn(async () => current),
      upsert: jest.fn(async () => ({ id: '119-hr-1' })),
    },
    congressBillAction: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    federalEvidenceCheckpoint: { findUnique: jest.fn(async () => null), upsert: jest.fn() },
    $queryRawUnsafe: jest.fn(async () => (reuse ? [{ id: 'retained-source-proof' }] : [])),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (fn: any) => fn(db)),
  };
  return db;
}
describe('refresh canonical parent persistence', () => {
  it('creates a newly eligible parent and its complete actions through the canonical callback owner', async () => {
    const db = fixture();
    expect(await persistFederalBulkParent(db, bill())).toMatchObject({ status: 'written' });
    expect(db.congressBill.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          id: '119-hr-1',
          congress: 119,
          billType: 'hr',
          url: 'https://www.congress.gov/bill/119th-congress/house-bill/1',
          title: 'Synthetic parent',
          introducedDate: new Date('2026-01-01'),
        }),
      }),
    );
    expect(db.congressBillAction.createMany).toHaveBeenCalledWith({
      data: [
        {
          billId: '119-hr-1',
          date: new Date('2026-01-01'),
          text: 'Introduced',
          type: null,
          chamber: null,
        },
      ],
    });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.congressBill.upsert.mock.calls[0][0].update).not.toHaveProperty('url');
  });
  it.each([
    ['s', 'senate-bill'],
    ['hjres', 'house-joint-resolution'],
    ['sjres', 'senate-joint-resolution'],
    ['hconres', 'house-concurrent-resolution'],
    ['sconres', 'senate-concurrent-resolution'],
    ['hres', 'house-resolution'],
    ['sres', 'senate-resolution'],
  ])('stores the existing canonical official URL for a new %s parent', async (type, segment) => {
    const db = fixture(),
      input = bill();
    input.id = `119-${type}-1`;
    await persistFederalBulkParent(db, input);
    expect(db.congressBill.upsert.mock.calls[0][0].create.url).toBe(
      `https://www.congress.gov/bill/119th-congress/${segment}/1`,
    );
  });
  it.each(['119-hr-01', '119-bad-1', '119-hr-1/path', '118-hr-1'])(
    'does not construct a stored source URL from a noncanonical refresh identity %s',
    async (id) => {
      const db = fixture(),
        input = bill();
      input.id = id;
      await expect(persistFederalBulkParent(db, input)).rejects.toThrow('PARENT_INCOMPLETE');
      expect(db.congressBill.upsert).not.toHaveBeenCalled();
    },
  );
  it.each([
    { updateDate: new Date('2026-03-01'), updateDateIncludingText: new Date('2026-02-02') },
    { updateDate: new Date('2026-02-01'), updateDateIncludingText: new Date('2026-03-01') },
  ])('preserves either newer canonical timestamp and all related actions', async (current) => {
    const db = fixture(current);
    expect(await persistFederalBulkParent(db, bill())).toMatchObject({ status: 'held' });
    expect(db.congressBill.upsert).not.toHaveBeenCalled();
    expect(db.congressBillAction.deleteMany).not.toHaveBeenCalled();
  });
  it('reuses only exact XML proof plus matching canonical metadata/text timestamps', async () => {
    const current = {
      updateDate: new Date('2026-02-01'),
      updateDateIncludingText: new Date('2026-02-02'),
    };
    const db = fixture(current, true);
    expect(await persistFederalBulkParent(db, bill())).toMatchObject({
      status: 'reused',
      reusedReceiptId: 'retained-source-proof',
    });
    expect(db.congressBill.upsert).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe.mock.calls[0][2]).toBe(bill().sourceContentHash);
    const changed = fixture(current, false);
    expect(await persistFederalBulkParent(changed, bill())).toMatchObject({ status: 'written' });
  });
  it('does not create a parent from incomplete title/action evidence', async () => {
    const db = fixture(),
      input = bill();
    input.parent!.actions[0]!.text = null;
    await expect(persistFederalBulkParent(db, input)).rejects.toThrow('PARENT_INCOMPLETE');
    expect(db.congressBill.upsert).not.toHaveBeenCalled();
  });
});
