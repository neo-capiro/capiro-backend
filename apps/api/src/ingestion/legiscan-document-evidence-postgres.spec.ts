import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { documentEvidence, persistDocumentEvidence } from './legiscan-document-evidence.js';
import type { LegiscanDocument } from '../external/legiscan/legiscan.client.js';
import { BILL_EXTRACTION_VERSION } from './bill-document-structure.js';
describe('immutable document bytes and source observations on PostgreSQL', () => {
  jest.setTimeout(30000);
  let p: PrismaClient, setup: Client;
  const schema = 'bill_document_' + randomUUID().replaceAll('-', ''),
    billKey = 'fl-2097-doc-' + randomUUID(),
    providerId = Math.floor(Math.random() * 100000000) + 600000000;
  const doc = (body: string): LegiscanDocument => ({
    doc_id: providerId,
    bill_id: providerId,
    type: 'Supplement',
    document_kind: 'supplement',
    mime: 'text/plain',
    doc: Buffer.from(body).toString('base64'),
    text_size: Buffer.byteLength(body),
    text_hash: createHash('md5').update(body).digest('hex'),
    date: '2097-01-02',
    title: 'Synthetic evidence',
    state_link: 'https://example.gov/same-source.txt',
  });
  const stub = { id: providerId, billId: providerId, kind: 'supplement' as const };
  beforeAll(async () => {
    const value = process.env.BILL_DOCUMENT_TEST_DATABASE_URL;
    if (!value) throw Error('BILL_DOCUMENT_TEST_DATABASE_URL_REQUIRED');
    const url = new URL(value);
    if (
      process.env.LEGIWATCH_PHASE5_TEST_DATABASE !== 'disposable' ||
      process.env.CAPIRO_DISPOSABLE_PG !== '1' ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/bill_document_test'
    )
      throw Error('Disposable DB required');
    setup = new Client({ connectionString: url.href });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;
      CREATE TABLE state_bill(id text PRIMARY KEY,state text NOT NULL,session text NOT NULL,
        session_key text NOT NULL,identifier text NOT NULL,bill_number text NOT NULL,title text NOT NULL,
        legiscan_bill_id integer UNIQUE,report_source_facts jsonb);
      CREATE TABLE official_hearing_transcript_revision(id uuid PRIMARY KEY);`);
    // Execute exact canonical table/constraint/trigger SQL. Unrelated migration
    // alterations, historical backfills and application-role grants are outside
    // this empty, owned fixture; no persistence path or invariant is mocked.
    const migration = (name: string) =>
      readFileSync(resolve(process.cwd(), 'prisma/migrations', name, 'migration.sql'), 'utf8');
    const section = (sql: string, start: string, end?: string) => {
      const first = sql.indexOf(start),
        last = end ? sql.indexOf(end, first + start.length) : sql.length;
      if (first < 0 || last <= first) throw Error('CANONICAL_DOCUMENT_FIXTURE_SQL_NOT_FOUND');
      return sql.slice(first, last);
    };
    await setup.query(
      section(
        migration('20280910010000_legiwatch_published_records'),
        'CREATE TABLE "state_bill_published_record"',
        'ALTER TABLE legiwatch_notification_event DROP CONSTRAINT',
      ),
    );
    const revisions = migration('20280913010000_legiwatch_record_revisions');
    await setup.query(
      section(
        revisions,
        'ALTER TABLE state_bill_published_record DROP CONSTRAINT',
        'ALTER TABLE state_roll_call_vote',
      ),
    );
    await setup.query(section(revisions, 'CREATE FUNCTION legiwatch_reject_record_rewrite()'));
    await setup.query(
      section(
        migration('20280913013000_legiwatch_record_commit_boundary'),
        'CREATE FUNCTION legiwatch_lock_record_commit()',
        'CREATE TRIGGER transcript_record_commit_boundary',
      ),
    );
    const observations = migration('20280913019000_legiwatch_source_observations');
    await setup.query(
      section(
        observations,
        'CREATE TABLE published_record_source_observation',
        'INSERT INTO published_record_source_observation',
      ),
    );
    await setup.query(
      section(
        observations,
        'CREATE TRIGGER published_record_observation_commit_boundary',
        'GRANT SELECT,INSERT ON published_record_source_observation',
      ),
    );
    url.searchParams.set('schema', schema);
    p = new PrismaClient({ datasources: { db: { url: url.href } } });
    await p.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,legiscan_bill_id) VALUES(${billKey},'FL','2097','2097','HB 1','hb1','Synthetic document',${providerId})`;
  });
  afterAll(async () => {
    await p?.$disconnect();
    if (setup) {
      try {
        await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await setup.end();
      }
    }
  });
  it('retains corrected bytes at the same URL and a later restoration without duplicating content', async () => {
    const first = doc('Original public text.'),
      second = doc('Corrected public text.');
    await persistDocumentEvidence(p, billKey, first, stub);
    await persistDocumentEvidence(p, billKey, second, stub);
    await persistDocumentEvidence(p, billKey, second, stub);
    await persistDocumentEvidence(p, billKey, first, stub);
    const rows = await p.stateBillPublishedRecord.findMany({
      where: { billKey, kind: 'document' },
      orderBy: { firstObservedAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(
      rows.map((r) => (r.evidence as { contentSnapshotBase64: string }).contentSnapshotBase64),
    ).toEqual([first.doc, second.doc]);
    const trail = await p.$queryRaw<
      Array<{ state_record_id: string }>
    >`SELECT state_record_id FROM published_record_source_observation WHERE source_key=${`state:${billKey}:document:legiscan:supplement:${providerId}`} ORDER BY id`;
    expect(trail.map((r) => r.state_record_id)).toEqual([rows[0]!.id, rows[1]!.id, rows[0]!.id]);
    expect((rows[0]!.evidence as { parserVersion: string }).parserVersion).toBe(
      BILL_EXTRACTION_VERSION,
    );
  });
  it('rejects wrong bill, unqualified document identity, invalid provider hash and unreadable text encoding', async () => {
    await expect(
      persistDocumentEvidence(p, billKey, { ...doc('Wrong'), bill_id: providerId + 1 }, stub),
    ).rejects.toThrow('DOCUMENT_SUBJECT_MISMATCH');
    await expect(
      persistDocumentEvidence(p, billKey, doc('Wrong'), { ...stub, id: providerId + 1 }),
    ).rejects.toThrow('DOCUMENT_SUBJECT_MISMATCH');
    await expect(
      persistDocumentEvidence(p, billKey, { ...doc('Wrong'), text_hash: '0'.repeat(32) }, stub),
    ).rejects.toThrow('DOCUMENT_PROVIDER_HASH_MISMATCH');
    const unreadable = await documentEvidence(doc('\uFFFD'), {
      billId: providerId,
      docId: providerId,
    });
    expect(unreadable.evidence).toMatchObject({
      extractionState: 'unreadable',
      sections: [],
      structure: { warnings: ['DOCUMENT_TEXT_ENCODING_UNQUALIFIED'] },
    });
    expect(await p.stateBillPublishedRecord.count({ where: { billKey } })).toBe(2);
  });
  it('labels unavailable content and blank text without claiming usable evidence', async () => {
    const binary = await documentEvidence(
      { ...doc('Unreadable binary'), mime: 'application/octet-stream' },
      { billId: providerId, docId: providerId },
    );
    expect(binary.evidence).toMatchObject({
      extractionState: 'unreadable',
      coverage: 'unknown',
      sections: [],
    });
    const blank = await documentEvidence(doc('   '), { billId: providerId, docId: providerId });
    expect(blank.evidence.extractionState).toBe('unreadable');
  });
  it('retains provider-validated bad text bytes as unreadable for later reprocessing', async () => {
    const invalid = doc('\uFFFD');
    expect(await persistDocumentEvidence(p, billKey, invalid, stub)).toBe('unreadable');
    const rows = await p.stateBillPublishedRecord.findMany({
      where: { billKey, kind: 'document' },
    });
    const failed = rows
      .map((r) => r.evidence as any)
      .find((e) => e.extractionState === 'unreadable');
    expect(failed.contentSnapshotBase64).toBe(invalid.doc);
    expect(failed.structure.sections).toEqual([]);
    expect(failed.structure.text).toBe('');
    expect(rows).toHaveLength(3);
  });
});
