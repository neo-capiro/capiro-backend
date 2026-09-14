import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import { applyHistoricalDataset } from './legiscan-historical-research.js';
import type { LegiscanBill, LegiscanSession } from '../external/legiscan/legiscan.client.js';
describe('selected historical canonical ingestion', () => {
  const p = new PrismaClient(),
    n = 500000000 + Math.floor(Math.random() * 100000000),
    session: LegiscanSession = {
      session_id: n,
      year_start: 2024,
      year_end: 2024,
      session_name: 'Synthetic prior session',
      special: 1,
      prior: 1,
    };
  const raw: LegiscanBill = {
    state: 'FL',
    bill_id: n,
    bill_number: 'HB7',
    change_hash: 'original',
    session,
    title: 'Synthetic history',
    description: 'Preserve current state.',
    status: 1,
    body: 'H',
    history: [{ date: '2024-01-01', action: 'Filed', chamber: 'H', importance: 0 }],
    sponsors: [],
    texts: [],
    votes: [],
    amendments: [],
    supplements: [],
    calendar: [
      {
        type: 'Hearing',
        date: '2099-01-01',
        time: '10:00',
        location: 'Synthetic',
        description: 'Must not schedule a capture',
      },
    ],
    committee: { committee_id: n, name: 'Must not rename current committee', chamber: 'H' },
  } as LegiscanBill;
  const zip = async (b: LegiscanBill) => {
    const z = new JSZip();
    z.file('FL/2024/bill/' + n + '.json', JSON.stringify({ bill: b }));
    return z.generateAsync({ type: 'nodebuffer' });
  };
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE7_TEST_DATABASE !== 'disposable' ||
      !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)
    )
      throw Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
    await p.$connect();
  });
  afterAll(() => p.$disconnect());
  it('imports and replays prior evidence without current calendar, directory or observation writes', async () => {
    const before = await p.$queryRaw<
      Array<{ committees: bigint; observations: bigint; calendars: bigint }>
    >`SELECT (SELECT count(*) FROM state_committee) AS committees,(SELECT count(*) FROM published_record_source_observation) AS observations,(SELECT count(*) FROM state_bill_calendar_event) AS calendars`;
    const archive = await zip(raw),
      first = await applyHistoricalDataset(p, 'FL', session, archive),
      second = await applyHistoricalDataset(p, 'FL', session, archive);
    expect(first.outcomes[0]!.status).toBe('imported');
    expect(second.outcomes[0]!.status).toBe('retained');
    expect(
      await p.$queryRaw`SELECT (SELECT count(*) FROM state_committee) AS committees,(SELECT count(*) FROM published_record_source_observation) AS observations,(SELECT count(*) FROM state_bill_calendar_event) AS calendars`,
    ).toEqual(before);
    const held = await applyHistoricalDataset(
      p,
      'FL',
      session,
      await zip({ ...raw, change_hash: 'changed', title: 'Must not overwrite' }),
    );
    expect(held.outcomes[0]!.status).toBe('held');
    expect(
      (await p.stateBill.findUnique({ where: { id: first.outcomes[0]!.billId } }))!.title,
    ).toBe(raw.title);
  });
  it('rejects current and mismatched sessions before canonical writes', async () => {
    await expect(
      applyHistoricalDataset(p, 'FL', { ...session, prior: 0 }, await zip(raw)),
    ).rejects.toThrow('EXPLICIT_COMPLETED_PRIOR_SESSION_REQUIRED');
    await expect(
      applyHistoricalDataset(p, 'FL', session, await zip({ ...raw, state: 'TX' })),
    ).rejects.toThrow('HISTORICAL_DATASET_IDENTITY_MISMATCH');
  });
});
