// Explicit qualification only: node --import tsx --test <this file> in a disposable localhost PostgreSQL harness.
const { test, before, after, beforeEach } = require('node:test'),
  assert = require('node:assert/strict');
const r = require('./runtime.cjs'),
  ROOT = process.env.HB1211_TEST_API_ROOT || 'C:/dev/main/legiwatch-qa-20261005/apps/api';
const SOURCE = 'a'.repeat(40),
  IMAGE = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:' + 'b'.repeat(64),
  BINDING = { sourceSha: SOURCE, image: IMAGE };
const { Client } = require(ROOT + '/node_modules/pg'),
  JSZip = require(ROOT + '/node_modules/jszip');
const { parseDatasetZip } = require(ROOT + '/src/external/legiscan/legiscan-dataset.util.ts'),
  { reportSourceFacts } = require(ROOT + '/src/ingestion/legiscan-published-records.ts');
let db, bytes;
const raw = {
  bill_id: 2068308,
  state: 'FL',
  session: { session_id: 2220 },
  change_hash: r.BILL_HASH,
  texts: [{ doc_id: 42, text_hash: 'test-text-hash' }],
  amendments: [],
  supplements: [],
};
const deps = {
  parseDatasetZip,
  reportSourceFacts,
  getDatasetList: async () => [
    {
      session_id: 2220,
      dataset_hash: 'test-dataset',
      dataset_date: '2026-10-01',
      access_key: 'test-only',
    },
  ],
  getDataset: async () => ({
    session_id: 2220,
    dataset_hash: 'test-dataset',
    dataset_date: '2026-10-01',
    zip: bytes.toString('base64'),
  }),
};
async function environment() {
  const e = {
    GIT_SHA: SOURCE,
    RELEASE_SHA: SOURCE,
    HB1211_DATASET_SOURCE_SHA: SOURCE,
    HB1211_DATASET_IMAGE: IMAGE,
    LEGISCAN_DOCUMENT_EVIDENCE_ENABLED: 'true',
    LEGISCAN_API_KEY: 'test-never-sent',
    HB1211_DATASET_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
  };
  e.HB1211_DATASET_APPROVED_PLAN = r.hash(
    r.previewPlan(await r.transaction(db, true, () => r.snapshot(db)), 30000, BINDING),
  );
  return e;
}
before(async () => {
  if (
    process.env.LEGIWATCH_PHASE7_TEST_DATABASE !== 'disposable' ||
    !['localhost', '127.0.0.1'].includes(
      new URL(process.env.DATABASE_URL ?? 'http://invalid').hostname,
    )
  )
    throw Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  // Check the actual migrated public contract BEFORE temporary fixtures can shadow it.
  // An absent production-named bill is expected; only schema/privileges are asserted here.
  const publicSnapshot = await r.transaction(db, true, () => r.snapshot(db));
  assert.equal(publicSnapshot.permissions.length, 12);
  assert.ok(
    publicSnapshot.permissions.every((p) => p.allowed === true),
    'Migrated public schema lacks required existing privileges',
  );
  await r.transaction(db, true, async () => {
    await db.query(
      'SELECT content_hash,original_bytes_base64,observed_at FROM public.legal_dataset_archive LIMIT 0',
    );
    await db.query(
      'SELECT id,source,scope,manifest,complete,observed_at FROM public.legal_source_receipt LIMIT 0',
    );
    await db.query(
      "SELECT document_kind,provider_id,provider_hash FROM public.legiwatch_research_document_source WHERE is_current AND coverage='complete_document' AND extraction_state='extracted' LIMIT 0",
    );
  });
  // Temporary tables shadow public names only in this connection; no production or shared fixture rows are touched.
  await db.query(`CREATE TEMP TABLE state_bill(id text PRIMARY KEY,state text,session_key text,legiscan_bill_id integer,legiscan_change_hash text,report_source_facts jsonb,source_checked_at timestamptz,title text);
 CREATE TEMP TABLE state_session(legiscan_session_id integer,state text,session_key text);
 CREATE TEMP TABLE state_sync_cursor(id text PRIMARY KEY,state text,session_id integer,session_key text,queries_used integer,quota_month text);
 CREATE TEMP TABLE state_bill_version(id text PRIMARY KEY,bill_key text,body text);
 CREATE TEMP TABLE legal_source_receipt(id text PRIMARY KEY,source text,scope jsonb,manifest jsonb,complete boolean,observed_at timestamptz);
 CREATE TEMP TABLE legal_dataset_archive(content_hash text PRIMARY KEY,original_bytes_base64 text,observed_at timestamptz);
 CREATE TEMP TABLE legiwatch_research_document_source(bill_id text,document_kind text,provider_id text,provider_hash text,is_current boolean,coverage text,extraction_state text);
 CREATE TEMP TABLE sync_run(source text,status text);
 CREATE FUNCTION pg_temp.corrupt_title() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.title='unapproved-trigger-change';RETURN NEW;END $$;`);
  const z = new JSZip();
  z.file('FL/2026/bill/2068308.json', JSON.stringify({ bill: raw }));
  bytes = await z.generateAsync({ type: 'nodebuffer' });
});
beforeEach(async () => {
  await db.query(`DROP TRIGGER IF EXISTS deliberate_guard_test ON state_bill; TRUNCATE state_bill,state_session,state_sync_cursor,state_bill_version,legal_source_receipt,legal_dataset_archive,legiwatch_research_document_source,sync_run;
 INSERT INTO state_session VALUES(2220,'FL','2026');
 INSERT INTO state_sync_cursor VALUES('FL-2220','FL',2220,'2026',28003,to_char(now() AT TIME ZONE 'UTC','YYYY-MM'));`);
  await db.query(
    "INSERT INTO state_bill VALUES($1,'FL','2026',2068308,$2,'{\"retainedFact\":true}',NULL,'Original title')",
    [r.BILL, r.BILL_HASH],
  );
  await db.query('INSERT INTO state_bill_version VALUES($1,$2,$3)', [
    'retained-version',
    r.BILL,
    'protected text',
  ]);
});
after(async () => {
  if (db) await db.end();
});
test('actual SQL roundtrip survives jsonb ordering and changes only missing inventory', async () => {
  const e = await environment(),
    candidate = await r.retrieve(db, deps, e);
  assert.equal(
    (await db.query('SELECT queries_used FROM state_sync_cursor')).rows[0].queries_used,
    28011,
  );
  assert.equal(
    (await db.query('SELECT report_source_facts FROM state_bill')).rows[0].report_source_facts
      .documentInventory,
    undefined,
  );
  e.HB1211_DATASET_CANDIDATE_ID = candidate.candidateId;
  e.HB1211_DATASET_APPROVED_PLAN = candidate.planHash;
  const result = await r.apply(db, deps, e);
  assert.equal(result.billWrites, 1);
  assert.equal(result.missingDocuments.length, 1);
  const b = (await db.query('SELECT * FROM state_bill')).rows[0];
  assert.equal(b.title, 'Original title');
  assert.equal(b.source_checked_at, null);
  assert.equal(b.report_source_facts.retainedFact, true);
  assert.equal(
    (await db.query('SELECT body FROM state_bill_version')).rows[0].body,
    'protected text',
  );
  await assert.rejects(r.apply(db, deps, e), /MISSING_INVENTORY_ONLY/);
});
test('protected trigger changes cause real transaction rollback, preserving candidate only', async () => {
  const e = await environment(),
    candidate = await r.retrieve(db, deps, e);
  e.HB1211_DATASET_CANDIDATE_ID = candidate.candidateId;
  e.HB1211_DATASET_APPROVED_PLAN = candidate.planHash;
  await db.query(
    'CREATE TRIGGER deliberate_guard_test BEFORE UPDATE ON state_bill FOR EACH ROW EXECUTE FUNCTION pg_temp.corrupt_title()',
  );
  await assert.rejects(r.apply(db, deps, e), /PROTECTED_DATA_CHANGED/);
  const b = (await db.query('SELECT * FROM state_bill')).rows[0];
  assert.equal(b.title, 'Original title');
  assert.equal(b.report_source_facts.documentInventory, undefined);
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM legal_source_receipt')).rows[0].n,
    2,
  );
});
test('fresh quota drift rolls back before any provider call or reservation receipt', async () => {
  const e = await environment();
  await db.query('UPDATE state_sync_cursor SET queries_used=29999');
  let calls = 0;
  await assert.rejects(
    r.retrieve(
      db,
      {
        ...deps,
        getDatasetList: async () => {
          calls++;
          return [];
        },
      },
      e,
    ),
    /HARD_CAP_HOLD/,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM legal_source_receipt')).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query('SELECT queries_used FROM state_sync_cursor')).rows[0].queries_used,
    29999,
  );
});
test('conflicting archive insert preserves original observation time, not fresh timestamp', async () => {
  const observedAt = '2026-09-20T01:02:03.000Z';
  await db.query('INSERT INTO legal_dataset_archive VALUES($1,$2,$3)', [
    r.bytesHash(bytes),
    bytes.toString('base64'),
    observedAt,
  ]);
  const c = await r.retrieve(db, deps, await environment());
  assert.equal(c.applyPlan.inventory.observedAt, observedAt);
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM legal_dataset_archive')).rows[0].n,
    1,
  );
});
