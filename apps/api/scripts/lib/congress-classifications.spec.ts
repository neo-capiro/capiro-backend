import {
  authoritativeCongressClassifications,
  fetchCongressCommittees,
  fetchCongressSubjects,
  replaceCongressBillClassificationsAtomically,
  type CongressClassificationPrisma,
} from './congress-classifications';

function prismaMock() {
  const tx = {
    congressBillSubject: {
      deleteMany: jest.fn(async () => ({ count: 1 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    congressBillCommittee: {
      deleteMany: jest.fn(async () => ({ count: 1 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const raw = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  return { tx, raw, prisma: raw as unknown as CongressClassificationPrisma };
}

describe('Congress bill classification ingestion', () => {
  it('accepts authoritative empty subject and committee arrays', async () => {
    await expect(
      fetchCongressSubjects(async () => ({
        subjects: { legislativeSubjects: [] },
      })),
    ).resolves.toEqual({ ok: true, data: [] });
    await expect(fetchCongressCommittees(async () => ({ committees: [] }))).resolves.toEqual({
      ok: true,
      data: [],
    });
  });

  it.each([
    null,
    {},
    { subjects: {} },
    { subjects: { legislativeSubjects: [{ name: '' }] } },
    { subjects: { legislativeSubjects: [{ name: null }] } },
  ])(
    'rejects a missing or malformed subjects payload without treating it as empty',
    async (body) => {
      const result = await fetchCongressSubjects(async () => body as never);
      expect(result).toMatchObject({ ok: false });
    },
  );

  it.each([
    null,
    {},
    { committees: null },
    { committees: [{ name: '' }] },
    { committees: [{ name: 'Judiciary', chamber: 7 }] },
  ])(
    'rejects a missing or malformed committees payload without treating it as empty',
    async (body) => {
      const result = await fetchCongressCommittees(async () => body as never);
      expect(result).toMatchObject({ ok: false });
    },
  );

  it('omits failed subresources while retaining successful empty responses', () => {
    const failed = { ok: false as const, error: new Error('upstream 503') };
    const authoritative = authoritativeCongressClassifications(failed, {
      ok: true,
      data: [],
    });

    expect(authoritative).toEqual({ committees: [] });
    expect('subjects' in authoritative).toBe(false);
  });

  it('atomically replaces only the successful subresources', async () => {
    const db = prismaMock();

    await replaceCongressBillClassificationsAtomically(db.prisma, '119-hjres-7', {
      committees: [
        {
          name: 'House Judiciary',
          chamber: 'House',
          type: 'Standing',
          systemCode: 'hsju00',
        },
      ],
    });

    expect(db.raw.$transaction).toHaveBeenCalledTimes(1);
    expect(db.tx.congressBillSubject.deleteMany).not.toHaveBeenCalled();
    expect(db.tx.congressBillSubject.createMany).not.toHaveBeenCalled();
    expect(db.tx.congressBillCommittee.deleteMany).toHaveBeenCalledWith({
      where: { billId: '119-hjres-7' },
    });
    expect(db.tx.congressBillCommittee.createMany).toHaveBeenCalledWith({
      data: [
        {
          billId: '119-hjres-7',
          committeeName: 'House Judiciary',
          committeeCode: 'hsju00',
          chamber: 'House',
        },
      ],
    });
  });

  it('uses an authoritative empty response to clear only that subresource', async () => {
    const db = prismaMock();

    await replaceCongressBillClassificationsAtomically(db.prisma, '119-hjres-7', {
      subjects: [],
    });

    expect(db.raw.$transaction).toHaveBeenCalledTimes(1);
    expect(db.tx.congressBillSubject.deleteMany).toHaveBeenCalledWith({
      where: { billId: '119-hjres-7' },
    });
    expect(db.tx.congressBillSubject.createMany).not.toHaveBeenCalled();
    expect(db.tx.congressBillCommittee.deleteMany).not.toHaveBeenCalled();
  });

  it('does not open a transaction when neither subresource is authoritative', async () => {
    const db = prismaMock();

    await replaceCongressBillClassificationsAtomically(db.prisma, '119-hjres-7', {});

    expect(db.raw.$transaction).not.toHaveBeenCalled();
  });
});
