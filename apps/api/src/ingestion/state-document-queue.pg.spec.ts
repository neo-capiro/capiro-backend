/** Real queue SQL with synthetic tables; transport and extraction are separately tested owners. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { drainStateDocuments } from '../../scripts/sync-state-text-drain.js';
import { queueEventRecordRefresh } from './legiwatch-event-record-refresh.js';
import { retrieveStateDocument, StateDocumentRetrievalError } from './state-document-retrieval.js';
import { persistDocumentEvidence } from './legiscan-document-evidence.js';
jest.mock('./state-document-retrieval.js', () => ({
  retrieveStateDocument: jest.fn(),
  StateDocumentRetrievalError: class extends Error {
    retryAfterMs = 10800000;
  },
}));
jest.mock('./legiscan-document-evidence.js', () => ({
  persistDocumentEvidence: jest.fn(async () => 'extracted'),
}));

describe('exact historical document queue on disposable PostgreSQL', () => {
  jest.setTimeout(30000);
  let admin: PrismaClient, db: PrismaClient;
  const schema = 'bill_queue_' + randomUUID().replaceAll('-', '');
  const oldHash = 'a'.repeat(32),
    newHash = 'b'.repeat(32);
  beforeAll(async () => {
    const value = process.env.BILL_STATE_WRITER_TEST_DATABASE_URL;
    if (!value) throw Error('BILL_STATE_WRITER_TEST_DATABASE_URL_REQUIRED');
    const url = new URL(value);
    if (
      process.env.CAPIRO_DISPOSABLE_PG !== '1' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/bill_text_test'
    )
      throw Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
    admin = new PrismaClient({ datasources: { db: { url: value } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('schema', schema);
    db = new PrismaClient({ datasources: { db: { url: url.href } } });
    for (const ddl of [
      'CREATE TABLE state_bill(id text PRIMARY KEY,state text,session_key text,legiscan_bill_id int,latest_action_date date,legiscan_progress jsonb,report_source_facts jsonb)',
      'CREATE TABLE state_bill_action(bill_key text,date date)',
      'CREATE TABLE state_bill_published_record(id uuid,bill_key text,kind text,event_date text,evidence jsonb)',
      'CREATE TABLE state_sync_cursor(id text,state text,session_key text)',
      'CREATE TABLE bill_text_extraction(source_kind text,revision_id uuid,parser_version text,completeness text)',
      `CREATE TABLE state_bill_record_check(bill_key text,kind text,source_identity text,state text,attempts int,attempted_at timestamptz,checked_at timestamptz,next_check_at timestamptz,error_code text,provider_hash text,PRIMARY KEY(bill_key,kind,source_identity))`,
      'CREATE TABLE legiwatch_event_record_watch(event_id text,next_check_at timestamptz,expires_at timestamptz,attempts int,state text)',
      'CREATE TABLE committee_hearing(id text,geographic_jurisdiction text)',
      'CREATE TABLE legislative_agenda_item(state_bill_key text,active boolean,hearing_id text)',
    ])
      await db.$executeRawUnsafe(ddl);
    const facts = {
      retainedDocumentStubs: [oldHash, newHash].map((providerHash) => ({
        kind: 'text',
        providerId: 20,
        providerHash,
      })),
    };
    await db.$executeRawUnsafe(
      "INSERT INTO state_bill VALUES('fl-2025-hb1','FL','2025',10,'2026-01-01','[]',$1::jsonb)",
      JSON.stringify(facts),
    );
    await db.$executeRawUnsafe("INSERT INTO state_sync_cursor VALUES('FL-1','FL','2025')");
    await db.$executeRawUnsafe(
      "INSERT INTO state_bill_record_check(bill_key,kind,source_identity,state,attempts,next_check_at) VALUES('fl-2025-hb1','document','text:20','failed',8,now())",
    );
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.$disconnect();
    }
  });
  it('fans out legacy work, retries hashes independently at cap1, and never sends hash work through getBill refresh', async () => {
    jest.mocked(retrieveStateDocument).mockImplementation(async (_db, request) => {
      if (request.stub.providerHash === oldHash)
        throw new StateDocumentRetrievalError('PUBLISHER_UNAVAILABLE');
      return { document: {} as any, apiAttempts: 0, acquisition: 'publisher' };
    });
    const options = { states: ['FL'], limit: 1, commit: true, publisherOnly: true };
    expect(await drainStateDocuments(db, options)).toMatchObject({ errors: 1, inserted: 0 });
    expect(await drainStateDocuments(db, options)).toMatchObject({ errors: 0, inserted: 1 });
    expect(
      jest.mocked(retrieveStateDocument).mock.calls.map((call) => call[1].stub.providerHash),
    ).toEqual([oldHash, newHash]);
    expect(persistDocumentEvidence).toHaveBeenCalledTimes(1);
    const rows = await db.$queryRawUnsafe<any[]>(
      'SELECT source_identity,state,attempts,next_check_at FROM state_bill_record_check ORDER BY source_identity',
    );
    expect(rows[0]).toMatchObject({
      source_identity: 'text:20',
      state: 'metadata_only',
      attempts: 8,
      next_check_at: null,
    });
    expect(rows[1]).toMatchObject({
      source_identity: 'text:20:' + oldHash,
      state: 'failed',
      attempts: 1,
    });
    expect(rows[2]).toMatchObject({
      source_identity: 'text:20:' + newHash,
      state: 'available',
      attempts: 0,
    });
    await db.$executeRawUnsafe(
      'UPDATE state_bill_record_check SET next_check_at=now() WHERE source_identity=$1',
      'text:20:' + oldHash,
    );
    expect(await queueEventRecordRefresh(db, ['FL'])).toMatchObject({ eligible: 0, queued: 0 });
  });
  it('prioritizes text and amendments ahead of older supplements without changing version identities', async () => {
    jest.mocked(retrieveStateDocument).mockClear();
    jest
      .mocked(retrieveStateDocument)
      .mockResolvedValue({ document: {} as any, apiAttempts: 0, acquisition: 'publisher' });
    await db.$executeRawUnsafe('DELETE FROM state_bill_record_check');
    const stubs = ['supplement', 'amendment', 'text'].map((kind, i) => ({
      kind,
      providerId: i + 1,
      providerHash: newHash,
    }));
    await db.$executeRawUnsafe(
      'UPDATE state_bill SET report_source_facts=$1::jsonb',
      JSON.stringify({ retainedDocumentStubs: stubs }),
    );
    for (const stub of stubs)
      await db.$executeRawUnsafe(
        `INSERT INTO state_bill_record_check(bill_key,kind,source_identity,state,attempts,next_check_at)
      VALUES('fl-2025-hb1','document',$1,'pending',0,clock_timestamp()-$2*interval '1 day')`,
        `${stub.kind}:${stub.providerId}:${newHash}`,
        stub.kind === 'supplement' ? 2 : 1,
      );
    expect(
      await drainStateDocuments(db, {
        states: ['FL'],
        limit: 2,
        commit: true,
        publisherOnly: true,
      }),
    ).toMatchObject({ inserted: 2, errors: 0 });
    expect(
      jest
        .mocked(retrieveStateDocument)
        .mock.calls.map((call) => call[1].stub.kind)
        .sort(),
    ).toEqual(['amendment', 'text']);
    expect(
      await db.$queryRawUnsafe(
        "SELECT state,attempts FROM state_bill_record_check WHERE source_identity LIKE 'supplement:%'",
      ),
    ).toEqual([{ state: 'pending', attempts: 0 }]);
  });
});
