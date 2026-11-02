import {
  replaceCongressBillActionsAtomically,
  syncCongressBillActions,
  type CongressActionPrisma,
  type CongressActionsResponse,
  type NormalizedCongressAction,
} from './congress-actions';
import type { PrismaClient } from '@prisma/client';
import { withFederalBillWriter } from '../../src/ingestion/federal-bill-writer';

function prismaMock() {
  let inTransaction = false;
  const requireTransaction = () => {
    if (!inTransaction) throw Error('ACTION_OPERATION_OUTSIDE_TRANSACTION');
  };
  const deleteOperation = { operation: 'delete' };
  const createOperation = { operation: 'create' };
  const baselineOperation = { operation: 'baseline' };
  const raw = {
    congressBillAction: {
      deleteMany: jest.fn(async () => {
        requireTransaction();
        return deleteOperation;
      }),
      createMany: jest.fn(async () => {
        requireTransaction();
        return createOperation;
      }),
      findMany: jest.fn(async (): Promise<NormalizedCongressAction[]> => {
        requireTransaction();
        return [];
      }),
    },
    federalEvidenceCheckpoint: {
      findUnique: jest.fn(async (): Promise<{ status: string } | null> => {
        requireTransaction();
        return null;
      }),
      upsert: jest.fn(async () => {
        requireTransaction();
        return baselineOperation;
      }),
    },
    $executeRaw: jest.fn(async () => {
      requireTransaction();
      return { operation: 'raw' };
    }),
    $queryRawUnsafe: jest.fn(async () => [{ source: 'congress-bills' }]),
    $executeRawUnsafe: jest.fn(async () => 1),
    $transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      if (typeof run !== 'function') throw Error('CALLBACK_TRANSACTION_REQUIRED');
      inTransaction = true;
      try {
        return await run(raw);
      } finally {
        inTransaction = false;
      }
    }),
  };

  return {
    raw,
    prisma: raw as unknown as CongressActionPrisma,
    deleteOperation,
    createOperation,
    baselineOperation,
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
    expect(db.raw.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(db.raw.$executeRaw).not.toHaveBeenCalled();
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
    expect(db.raw.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('emits the first later action after an authoritative empty baseline', async () => {
    const db = prismaMock();
    db.raw.federalEvidenceCheckpoint.findUnique.mockResolvedValueOnce({ status: 'completed' });

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hres-215',
      fetchPage: async () => ({
        actions: [{ actionDate: '2025-03-06', text: 'Introduced in House' }],
      }),
    });

    expect(result).toMatchObject({ ok: true, actions: [{ text: 'Introduced in House' }] });
    expect(db.raw.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.raw.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('uses the actual federal callback facade with one fenced transaction for both reads and writes', async () => {
    const db = prismaMock();
    const action = {
      date: new Date('2026-01-01'),
      text: 'Synthetic action',
      type: null,
      chamber: null,
    };
    await withFederalBillWriter(db.raw as unknown as PrismaClient, (writer) =>
      replaceCongressBillActionsAtomically(writer, '119-hr-999', [action]),
    );
    expect(db.raw.$transaction).toHaveBeenCalledTimes(1);
    expect(db.raw.$queryRawUnsafe).toHaveBeenCalledTimes(2); // acquire, then transaction fence
    const fence = db.raw.$queryRawUnsafe.mock.invocationCallOrder[1]!;
    expect(fence).toBeLessThan(
      db.raw.federalEvidenceCheckpoint.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(fence).toBeLessThan(db.raw.congressBillAction.findMany.mock.invocationCallOrder[0]!);
    expect(db.raw.congressBillAction.createMany).toHaveBeenCalledWith({
      data: [{ billId: '119-hr-999', ...action }],
    });
    expect(db.raw.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses a lost federal lease before reading or replacing action history', async () => {
    const db = prismaMock();
    db.raw.$queryRawUnsafe
      .mockResolvedValueOnce([{ source: 'congress-bills' }])
      .mockResolvedValueOnce([]);
    await expect(
      withFederalBillWriter(db.raw as unknown as PrismaClient, (writer) =>
        replaceCongressBillActionsAtomically(writer, '119-hr-999', []),
      ),
    ).rejects.toThrow('FEDERAL_WRITER_LEASE_LOST');
    expect(db.raw.federalEvidenceCheckpoint.findUnique).not.toHaveBeenCalled();
    expect(db.raw.congressBillAction.findMany).not.toHaveBeenCalled();
    expect(db.raw.congressBillAction.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps a completed baseline from emitting unchanged actions', async () => {
    const db = prismaMock();
    const action = {
      date: new Date('2026-01-01'),
      text: 'Synthetic unchanged action',
      type: null,
      chamber: null,
    };
    db.raw.federalEvidenceCheckpoint.findUnique.mockResolvedValue({ status: 'completed' });
    db.raw.congressBillAction.findMany.mockResolvedValue([action]);
    await replaceCongressBillActionsAtomically(db.prisma, '119-hr-999', [action]);
    expect(db.raw.$executeRaw).not.toHaveBeenCalled();
    expect(db.raw.federalEvidenceCheckpoint.upsert).toHaveBeenCalledTimes(1);
  });

  it('uses a trimmed actionCode when Congress returns a valid action with null text', async () => {
    const db = prismaMock();

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hres-212',
      fetchPage: async () => ({
        actions: [
          {
            actionDate: '2025-03-05',
            text: null,
            actionCode: '  Intro-H  ',
            type: 'IntroReferral',
            chamber: 'House',
          },
        ],
      }),
    });

    expect(result).toEqual({
      ok: true,
      actions: [
        {
          date: new Date('2025-03-05'),
          text: 'Intro-H',
          type: 'IntroReferral',
          chamber: 'House',
        },
      ],
    });
    expect(db.raw.congressBillAction.createMany).toHaveBeenCalledWith({
      data: [
        {
          billId: '119-hres-212',
          date: new Date('2025-03-05'),
          text: 'Intro-H',
          type: 'IntroReferral',
          chamber: 'House',
        },
      ],
    });
  });

  it('uses a trimmed type only when text and actionCode are unusable', async () => {
    const db = prismaMock();

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hres-213',
      fetchPage: async () => ({
        actions: [
          {
            actionDate: '2025-03-05',
            text: '  ',
            actionCode: null,
            type: '  IntroReferral  ',
          },
        ],
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      actions: [{ text: 'IntroReferral' }],
    });
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

  it('rejects an action with a date but no usable text, actionCode, or type', async () => {
    const db = prismaMock();

    const result = await syncCongressBillActions({
      prisma: db.prisma,
      billId: '119-hres-214',
      fetchPage: async () => ({
        actions: [
          {
            actionDate: '2025-03-05',
            text: null,
            actionCode: '  ',
            type: null,
          },
        ],
      }),
    });

    expect(result).toMatchObject({ ok: false, stage: 'fetch' });
    expect(db.raw.congressBillAction.deleteMany).not.toHaveBeenCalled();
    expect(db.raw.congressBillAction.createMany).not.toHaveBeenCalled();
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
