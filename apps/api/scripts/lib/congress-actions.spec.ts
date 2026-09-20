import {
  syncCongressBillActions,
  type CongressActionPrisma,
  type CongressActionsResponse,
} from './congress-actions';

function prismaMock() {
  const deleteOperation = { operation: 'delete' };
  const createOperation = { operation: 'create' };
  const raw = {
    congressBillAction: {
      deleteMany: jest.fn(() => deleteOperation),
      createMany: jest.fn(() => createOperation),
    },
    $transaction: jest.fn(async () => undefined),
  };

  return {
    raw,
    prisma: raw as unknown as CongressActionPrisma,
    deleteOperation,
    createOperation,
  };
}

describe('Congress bill action ingestion', () => {
  it('paginates every actions page and replaces the complete history atomically', async () => {
    const db = prismaMock();
    const fetchPage = jest.fn(
      async (nextPageUrl: string | null): Promise<CongressActionsResponse> => {
        if (nextPageUrl === null) {
          return {
            actions: [
              {
                actionDate: '2025-01-03',
                text: 'Introduced in House',
                type: 'IntroReferral',
                chamber: 'House',
              },
            ],
            pagination: { next: 'https://api.congress.gov/v3/actions?offset=250' },
          };
        }
        return {
          actions: [
            {
              actionDate: '2025-01-04',
              text: 'Referred to the House Committee on the Judiciary.',
            },
          ],
          pagination: { next: null },
        };
      },
    );

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hjres-7',
      fetchPage,
    });

    expect(result).toEqual({
      ok: true,
      actions: [
        {
          date: new Date('2025-01-03'),
          text: 'Introduced in House',
          type: 'IntroReferral',
          chamber: 'House',
        },
        {
          date: new Date('2025-01-04'),
          text: 'Referred to the House Committee on the Judiciary.',
          type: null,
          chamber: null,
        },
      ],
    });
    expect(fetchPage.mock.calls).toEqual([
      [null],
      ['https://api.congress.gov/v3/actions?offset=250'],
    ]);
    expect(db.raw.congressBillAction.deleteMany).toHaveBeenCalledWith({
      where: { billId: '119-hjres-7' },
    });
    expect(db.raw.congressBillAction.createMany).toHaveBeenCalledWith({
      data: [
        {
          billId: '119-hjres-7',
          date: new Date('2025-01-03'),
          text: 'Introduced in House',
          type: 'IntroReferral',
          chamber: 'House',
        },
        {
          billId: '119-hjres-7',
          date: new Date('2025-01-04'),
          text: 'Referred to the House Committee on the Judiciary.',
          type: null,
          chamber: null,
        },
      ],
    });
    expect(db.raw.$transaction).toHaveBeenCalledWith([db.deleteOperation, db.createOperation]);
  });

  it('treats a successful empty response as an authoritative empty history', async () => {
    const db = prismaMock();

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hjres-7',
      fetchPage: async () => ({ actions: [], pagination: { next: null } }),
    });

    expect(result).toEqual({ ok: true, actions: [] });
    expect(db.raw.congressBillAction.createMany).not.toHaveBeenCalled();
    expect(db.raw.$transaction).toHaveBeenCalledWith([db.deleteOperation]);
  });

  it('preserves existing rows when a later actions page fails', async () => {
    const db = prismaMock();
    const fetchPage = jest.fn(async (nextPageUrl: string | null) => {
      if (nextPageUrl === null) {
        return {
          actions: [{ actionDate: '2025-01-03', text: 'Introduced in House' }],
          pagination: { next: 'page-2' },
        };
      }
      throw new Error('upstream 503');
    });

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hjres-7',
      fetchPage,
    });

    expect(result).toMatchObject({
      ok: false,
      stage: 'fetch',
      error: new Error('upstream 503'),
    });
    expect(db.raw.congressBillAction.deleteMany).not.toHaveBeenCalled();
    expect(db.raw.congressBillAction.createMany).not.toHaveBeenCalled();
    expect(db.raw.$transaction).not.toHaveBeenCalled();
  });

  it('treats a null actions payload as a fetch failure, not an empty history', async () => {
    const db = prismaMock();

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hjres-7',
      fetchPage: async () => null,
    });

    expect(result).toMatchObject({ ok: false, stage: 'fetch' });
    expect(db.raw.$transaction).not.toHaveBeenCalled();
  });

  it('preserves existing rows when an upstream action is malformed', async () => {
    const db = prismaMock();

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hjres-7',
      fetchPage: async () => ({ actions: [{ actionDate: null, text: 'Missing a date' }] }),
    });

    expect(result).toMatchObject({ ok: false, stage: 'fetch' });
    expect(db.raw.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed on a repeated continuation instead of looping or writing partial rows', async () => {
    const db = prismaMock();

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hjres-7',
      fetchPage: async () => ({
        actions: [{ actionDate: '2025-01-03', text: 'Introduced in House' }],
        pagination: { next: 'page-2' },
      }),
    });

    expect(result).toMatchObject({ ok: false, stage: 'fetch' });
    expect(db.raw.$transaction).not.toHaveBeenCalled();
  });

  it('reports an atomic replacement failure', async () => {
    const db = prismaMock();
    db.raw.$transaction.mockRejectedValueOnce(new Error('transaction aborted'));

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hjres-7',
      fetchPage: async () => ({
        actions: [{ actionDate: '2025-01-03', text: 'Introduced in House' }],
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      stage: 'replace',
      error: new Error('transaction aborted'),
    });
    expect(db.raw.$transaction).toHaveBeenCalledTimes(1);
  });
});
