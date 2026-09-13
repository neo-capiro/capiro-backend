import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { persistOfficialTranscript, syncGovInfoHearingRecords } from './govinfo-hearing-records.js';
import type { HearingText } from '../external/govinfo/govinfo.service.js';
describe('GovInfo package revisions and bounded checkpoints on PostgreSQL', () => {
  jest.setTimeout(30000);
  const p = new PrismaClient(),
    stem = String(Date.now()),
    event = 'gov-' + randomUUID();
  const document = (i: number): HearingText => ({
    packageId: `CHRG-119hhrg${stem}${i}`,
    title: 'Synthetic published hearing',
    dateIssued: '2096-03-12',
    lastModified: '2096-04-01T00:00:00Z',
    sourceUrl: `https://www.govinfo.gov/content/pkg/CHRG-119hhrg${stem}${i}/html/CHRG-119hhrg${stem}${i}.htm`,
    format: 'htm',
    raw: '<p>' + 'Synthetic testimony. '.repeat(50) + '</p>',
    text: 'Synthetic testimony. '.repeat(50),
    heldDates: ['2096-01-02', '2096-02-03'],
    committees: [{ authorityId: 'qa' + stem, chamber: 'H', congress: '119' }],
  });
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE5_TEST_DATABASE !== 'disposable' ||
      !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)
    )
      throw Error('Disposable DB required');
    await p.$executeRaw`INSERT INTO committee_hearing(id,congress,geographic_jurisdiction,chamber,committee_code,committee_name,title,date,visibility) VALUES(${event},119,'US','House',${'qa' + stem},'Synthetic body','Actual held date fixture','2096-01-02','public')`;
    await p.$executeRaw`INSERT INTO committee_hearing(id,congress,geographic_jurisdiction,chamber,committee_code,committee_name,title,date,visibility) VALUES(${event + '-fl'},119,'FL','House',${'qa' + stem},'Synthetic body','Wrong jurisdiction fixture','2096-01-02','public')`;
  });
  afterAll(async () => {
    await p.$disconnect();
  });
  it('retains changed bytes and metadata, links held dates, and never assigns CHRG to Florida', async () => {
    const doc = document(0),
      first = await persistOfficialTranscript(p, 119, doc),
      again = await persistOfficialTranscript(p, 119, doc);
    expect(again.revisionId).toBe(first.revisionId);
    const revision = await persistOfficialTranscript(p, 119, {
      ...doc,
      text: doc.text + 'Corrected testimony.',
      raw: doc.raw + 'Correction',
      lastModified: '2096-04-02T00:00:00Z',
    });
    expect(revision.revisionId).not.toBe(first.revisionId);
    const rows = await p.$queryRaw<
      Array<{ id: string; extracted_text: string; published_date: string }>
    >`SELECT id,extracted_text,published_date FROM official_hearing_transcript_revision WHERE package_id=${doc.packageId}`;
    expect(rows.find((r) => r.id === first.revisionId)?.extracted_text).toBe(doc.text);
    expect(rows.every((r) => r.published_date === '2096-03-12')).toBe(true);
    const links = await p.$queryRaw<
      Array<{ hearing_id: string }>
    >`SELECT hearing_id FROM official_hearing_transcript_event WHERE revision_id=${revision.revisionId}::uuid`;
    expect(links).toEqual([{ hearing_id: event }]);
    const metadata = await persistOfficialTranscript(p, 119, {
      ...doc,
      title: '[ERRATA] Corrected committee membership',
    });
    expect(metadata.revisionId).not.toBe(first.revisionId);
    const classified = await p.$queryRaw<
      Array<{ metadata: { coverage: string } }>
    >`SELECT metadata FROM official_hearing_transcript_revision WHERE id=${metadata.revisionId}::uuid`;
    expect(classified[0]!.metadata.coverage).toBe('correction_only');
  });
  it('resumes a failed package and partial page without duplicating prior revisions', async () => {
    const source = 'govinfo-chrg:119:2096';
    await p.$executeRaw`DELETE FROM govinfo_hearing_record_checkpoint WHERE source=${source}`;
    let fail = true;
    const docs = [document(1), document(2), document(3)],
      gov = {
        listHearingsPage: jest.fn(async () => ({
          packages: docs.map((d) => ({
            packageId: d.packageId,
            lastModified: d.lastModified,
            dateIssued: d.dateIssued,
            congress: 119,
          })),
          nextPage: null,
        })),
        getHearingText: jest.fn(async (id: string) => {
          if (fail && id === docs[1]!.packageId) throw Error('Synthetic source failure');
          return docs.find((d) => d.packageId === id)!;
        }),
      };
    expect((await syncGovInfoHearingRecords(p, gov as never, 119, 2096, 2)).errors).toBe(1);
    const [failed] = await p.$queryRaw<
      Array<{ status: string; cursor: { offset: number } }>
    >`SELECT status,cursor FROM govinfo_hearing_record_checkpoint WHERE source=${source}`;
    expect(failed!.status).toBe('failed');
    expect(failed!.cursor.offset).toBe(1);
    fail = false;
    const result = await syncGovInfoHearingRecords(p, gov as never, 119, 2096, 2);
    expect(result.complete).toBe(true);
    expect(result.errors).toBe(0);
    expect(
      (
        await p.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*) AS n FROM official_hearing_transcript_revision WHERE package_id=ANY(${docs.map((d) => d.packageId)}::text[])`
      )[0]!.n,
    ).toBe(3n);
  });
  it('allows one source traversal while the existing checkpoint lease is held', async () => {
    const source = 'govinfo-chrg:119:2095';
    await p.$executeRaw`DELETE FROM govinfo_hearing_record_checkpoint WHERE source=${source}`;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const gov = {
      listHearingsPage: jest.fn(async () => {
        entered();
        await gate;
        return { packages: [], nextPage: null };
      }),
    };
    const first = syncGovInfoHearingRecords(p, gov as never, 119, 2095, 1);
    await ready;
    try {
      expect(await syncGovInfoHearingRecords(p, gov as never, 119, 2095, 1)).toMatchObject({
        busy: true,
        complete: false,
      });
      expect(gov.listHearingsPage).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
  });
});
