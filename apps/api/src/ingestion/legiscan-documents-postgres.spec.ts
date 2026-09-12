import { PrismaClient } from '@prisma/client';
import { upsertNormalizedStateBill, type NormalizedStateBill } from './legiscan-normalize.js';
describe('LegiScan durable documents on PostgreSQL', () => {
  const p = new PrismaClient(),
    billKey = 'fl-2097-hb901',
    doc = 209790101;
  const normalized: NormalizedStateBill = {
    billKey,
    state: 'FL',
    sessionKey: '2097',
    legiscanSessionId: 209790,
    identifier: 'HB 901',
    billNumber: 'hb901',
    title: 'Synthetic source bill',
    chamber: 'lower',
    classification: [],
    subjects: [],
    description: null,
    sponsorName: null,
    sponsorParty: null,
    sponsorCount: 0,
    legiscanStatus: 1,
    legiscanProgress: [],
    textDate: null,
    latestActionDate: null,
    latestActionText: null,
    url: null,
    stateUrl: null,
    legiscanBillId: 2097901,
    legiscanChangeHash: 'synthetic',
    committee: null,
    actions: [],
    sponsors: [],
    versions: [
      {
        legiscanDocId: doc,
        versionType: 'Introduced',
        date: new Date('2097-01-01'),
        stateUrl: 'https://example.invalid/original.pdf',
        mime: 'application/pdf',
      },
    ],
    links: [],
    calendarEvents: [],
    calendarSnapshot: { completeness: 'absent', issues: [], rows: [], raw: null },
    voteStubs: [],
  };
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Disposable PostgreSQL required');
    await p.$connect();
  });
  afterAll(async () => {
    await p.stateBill.deleteMany({ where: { id: { in: [billKey, 'fl-2097-hb902'] } } });
    await p.$disconnect();
  });
  it('retains UUID references through changed and omitted source versions', async () => {
    await upsertNormalizedStateBill(p, normalized);
    const before = await p.stateBillVersion.findUniqueOrThrow({ where: { legiscanDocId: doc } });
    await upsertNormalizedStateBill(p, {
      ...normalized,
      versions: [{ ...normalized.versions[0]!, stateUrl: 'https://example.invalid/corrected.pdf' }],
    });
    const after = await p.stateBillVersion.findUniqueOrThrow({ where: { legiscanDocId: doc } });
    expect(after.id).toBe(before.id);
    expect(after.stateUrl).toContain('corrected.pdf');
    await upsertNormalizedStateBill(p, { ...normalized, versions: [] });
    expect((await p.stateBillVersion.findUniqueOrThrow({ where: { legiscanDocId: doc } })).id).toBe(
      before.id,
    );
  });
  it('rejects a provider document identity reused for another bill', async () => {
    await expect(
      upsertNormalizedStateBill(p, {
        ...normalized,
        billKey: 'fl-2097-hb902',
        legiscanBillId: 2097902,
      }),
    ).rejects.toThrow('LEGISCAN_DOCUMENT_BILL_MISMATCH');
    expect(
      (await p.stateBillVersion.findUniqueOrThrow({ where: { legiscanDocId: doc } })).billKey,
    ).toBe(billKey);
  });
});
