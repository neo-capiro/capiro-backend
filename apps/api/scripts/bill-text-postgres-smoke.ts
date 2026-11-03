/** @cleanup-smoke noArgsExit=2 */
/** Disposable CI database only. Exercises actual concurrent indexes and queue conflict semantics. */
import { PrismaClient } from '@prisma/client';
import { main as index } from './index-bill-passages.js';
import { queueBillDocumentChecks } from '../src/ingestion/bill-document-queue.js';
import assert from 'node:assert/strict';
import { STATE_FY26_SQL } from '../src/ingestion/bill-text-scope.js';

async function main() {
  assert(process.env.DATABASE_URL, 'DATABASE_URL_REQUIRED');
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(process.env.CAPIRO_DISPOSABLE_PG, '1');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/bill_test');
  const db = new PrismaClient();
  try {
    await db.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await db.$executeRawUnsafe(
      'CREATE TABLE context_embeddings(id bigserial PRIMARY KEY,tenant_id uuid,source_type text,content_text text,embedding vector(1024))',
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE state_bill_record_check(bill_key text,kind text,source_identity text,state text,attempts int,provider_hash text,next_check_at timestamptz,PRIMARY KEY(bill_key,kind,source_identity))`,
    );
    await index(['--commit', '--expected-host', 'localhost']);
    await index(['--commit', '--expected-host', 'localhost']); // Existing exact indexes are accepted without ledger changes.
    assert.deepEqual(
      await db.$queryRawUnsafe("SELECT to_regclass('public._prisma_migrations')::text ledger"),
      [{ ledger: null }],
    );
    const raw = {
      texts: [
        { doc_id: 1, text_hash: 'old' },
        { doc_id: 2, text_hash: 'same' },
        { doc_id: 3, text_hash: 'new' },
      ],
    } as any;
    await queueBillDocumentChecks(db, 'ca-2025-ab1', raw);
    const first = await db.$queryRawUnsafe<any[]>(
      'SELECT * FROM state_bill_record_check ORDER BY source_identity',
    );
    assert.equal(first.length, 3);
    assert(
      first.every((r) => r.state === 'pending' && r.attempts === 0 && r.provider_hash === null),
    );
    await db.$executeRawUnsafe(
      "UPDATE state_bill_record_check SET state='available',provider_hash='same',next_check_at=now()+interval '7 days' WHERE source_identity='text:2'",
    );
    await db.$executeRawUnsafe(
      "UPDATE state_bill_record_check SET state='failed',attempts=3,next_check_at=now()+interval '3 days' WHERE source_identity='text:3'",
    );
    await db.$executeRawUnsafe(
      "UPDATE state_bill_record_check SET state='available',provider_hash='previous',next_check_at=now()+interval '7 days' WHERE source_identity='text:1'",
    );
    await queueBillDocumentChecks(db, 'ca-2025-ab1', raw);
    const rows = await db.$queryRawUnsafe<any[]>(
      'SELECT *,next_check_at>now() future FROM state_bill_record_check ORDER BY source_identity',
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0].future, false); // Changed document becomes due; completed hash is retained until fetched.
    assert.equal(rows[0].provider_hash, 'previous');
    assert.equal(rows[1].future, true); // Unchanged successful document keeps its schedule.
    assert.equal(rows[2].future, true); // Failed document keeps its retry backoff and attempt history.
    assert.equal(rows[2].attempts, 3);
    // Exact frozen hashes retry independently even when the publisher reuses
    // the same document ID/URL. The ordinary getBill refresh owner excludes
    // these hash-qualified rows; only the publisher-first drain consumes them.
    const oldHash = 'a'.repeat(32),
      newHash = 'b'.repeat(32);
    await queueBillDocumentChecks(
      db,
      'ca-2025-ab2',
      {
        texts: [
          { doc_id: 9, text_hash: oldHash },
          { doc_id: 9, text_hash: newHash },
        ],
      } as any,
      { exactVersions: true },
    );
    await db.$executeRawUnsafe(
      "UPDATE state_bill_record_check SET state='review_required',attempts=10,next_check_at=now()+interval '3 days' WHERE bill_key='ca-2025-ab2' AND source_identity=$1",
      'text:9:' + oldHash,
    );
    const exact = await db.$queryRawUnsafe<any[]>(
      "SELECT source_identity,attempts,state,next_check_at<=now() due FROM state_bill_record_check WHERE bill_key='ca-2025-ab2' ORDER BY source_identity",
    );
    assert.equal(exact.length, 2);
    assert.equal(exact[0].state, 'review_required');
    assert.equal(exact[1].attempts, 0);
    assert.equal(exact[1].due, true);
    const legacy = await db.$queryRawUnsafe<any[]>(
      "SELECT source_identity FROM state_bill_record_check d WHERE bill_key='ca-2025-ab2' AND d.next_check_at<=now() AND d.attempts<10 AND NOT(d.kind='document' AND d.source_identity ~ '^(text|amendment|supplement):[0-9]+:')",
    );
    assert.equal(legacy.length, 0);
    // Stored progress is official parent admission evidence even without history.
    await db.$executeRawUnsafe(
      'CREATE TABLE state_bill(id text PRIMARY KEY,latest_action_date date,legiscan_progress jsonb)',
    );
    await db.$executeRawUnsafe('CREATE TABLE state_bill_action(bill_key text,date date)');
    await db.$executeRawUnsafe(
      'CREATE TABLE state_bill_published_record(bill_key text,kind text,event_date text)',
    );
    await db.$executeRawUnsafe(`INSERT INTO state_bill VALUES
      ('progress-only','2025-02-01','[{"date":"2026-02-01"}]'),
      ('progress-start',NULL,'[{"date":"2025-10-01"}]'),
      ('progress-end',NULL,'[{"date":"2026-10-01"}]'),
      ('invalid-calendar',NULL,'[{"date":"2026-02-30"}]'),
      ('invalid-boundary',NULL,'[{"date":"2025-09-31"}]'),
      ('invalid-format',NULL,'[{"date":"not-a-date"}]'),
      ('non-array',NULL,'{"date":"2026-01-01"}'),
      ('absent',NULL,NULL)`);
    const eligible = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT b.id FROM state_bill b WHERE ${STATE_FY26_SQL} ORDER BY b.id`,
    );
    assert.deepEqual(
      eligible.map((row) => row.id),
      ['progress-only', 'progress-start'],
    );
    console.log('BILL_POSTGRES_SMOKE_PASS');
  } finally {
    await db.$disconnect();
  }
}
/** Exit 0: help/pass; 1: failed fixture; 2: missing isolated fixture configuration. */
if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'Usage: bill-text-postgres-smoke (requires CAPIRO_DISPOSABLE_PG=1 and DATABASE_URL for localhost/bill_test; creates synthetic fixture tables)',
    );
    process.exit(0);
  } else if (!process.env.DATABASE_URL || process.env.CAPIRO_DISPOSABLE_PG !== '1') {
    console.error(
      'Usage: bill-text-postgres-smoke (requires CAPIRO_DISPOSABLE_PG=1 and DATABASE_URL for localhost/bill_test)',
    );
    process.exit(2);
  } else {
    void main().catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
  }
}
