'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const r = require('./runtime.cjs');
const SOURCE = 'a'.repeat(40),
  IMAGE = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:' + 'b'.repeat(64),
  BINDING = { sourceSha: SOURCE, image: IMAGE };
const ROOT = process.env.HB1211_TEST_API_ROOT || 'C:/dev/main/legiwatch-qa-20261005/apps/api';
const { parseDatasetZip } = require(ROOT + '/src/external/legiscan/legiscan-dataset.util.ts');
const { reportSourceFacts } = require(ROOT + '/src/ingestion/legiscan-published-records.ts');
const JSZip = require(ROOT + '/node_modules/jszip');
const raw = () => ({
  bill_id: 2068308,
  state: 'FL',
  session: { session_id: 2220 },
  change_hash: r.BILL_HASH,
  texts: [{ doc_id: 42, text_hash: 'original-text-hash' }],
  amendments: [],
  supplements: [],
});
const snap = () => ({
  bill: {
    id: r.BILL,
    state: 'FL',
    session_key: '2026',
    legiscan_bill_id: 2068308,
    legiscan_change_hash: r.BILL_HASH,
    inventory: null,
    protected_hash: 'canonical-protected',
    other_facts_hash: 'other-facts',
  },
  sessions: [{ legiscan_session_id: 2220 }],
  cursor: { id: 'FL-2220', state: 'FL', session_id: 2220, session_key: '2026' },
  usage: { used: 28003, month: '2026-10' },
  versions: { count: 7, hash: 'versions-hash' },
  permissions: Array.from({ length: 12 }, () => ({ allowed: true })),
});
const env = () => ({
  GIT_SHA: SOURCE,
  RELEASE_SHA: SOURCE,
  HB1211_DATASET_SOURCE_SHA: SOURCE,
  HB1211_DATASET_IMAGE: IMAGE,
  LEGISCAN_DOCUMENT_EVIDENCE_ENABLED: 'true',
  LEGISCAN_API_KEY: 'synthetic-never-real',
  HB1211_DATASET_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
});
async function zip(bills = [raw()], extra) {
  const z = new JSZip();
  bills.forEach((b, i) => z.file('FL/2026/bill/' + i + '.json', JSON.stringify({ bill: b })));
  if (extra) extra(z);
  return z.generateAsync({ type: 'nodebuffer' });
}
class DB {
  constructor() {
    this.s = snap();
    this.receipts = [];
    this.archives = [];
    this.log = [];
    this.retained = [];
  }
  async query(sql, args = []) {
    this.log.push(sql);
    const rows = (x) => ({ rows: x, rowCount: x.length });
    if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') {
      this.saved = structuredClone({ s: this.s, receipts: this.receipts, archives: this.archives });
      return rows([]);
    }
    if (sql === 'ROLLBACK') {
      Object.assign(this, this.saved);
      return rows([]);
    }
    if (sql === 'COMMIT' || sql.startsWith('SET LOCAL') || sql.includes('pg_advisory'))
      return rows([]);
    if (sql.startsWith('SELECT id FROM state_bill')) return rows([{ id: r.BILL }]);
    if (sql.includes('FROM state_bill b WHERE')) return rows([structuredClone(this.s.bill)]);
    if (sql.startsWith('SELECT legiscan_session_id')) return rows(this.s.sessions);
    if (sql.startsWith('SELECT id,state,session_id')) return rows([this.s.cursor]);
    if (sql.includes('coalesce(sum(queries_used)')) return rows([structuredClone(this.s.usage)]);
    if (sql.includes('string_agg(to_jsonb(v)')) return rows([this.s.versions]);
    if (sql.startsWith('SELECT source FROM sync_run')) return rows(this.s.activeLegacy ?? []);
    if (sql.includes('has_table_privilege')) return rows(this.s.permissions);
    if (sql.startsWith('UPDATE state_sync_cursor')) {
      this.s.usage.used += 8;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO legal_source_receipt')) {
      this.receipts.push({
        id: args[0],
        source: args[1],
        scope: JSON.parse(args[2]),
        manifest: JSON.parse(args[3]),
        complete: args[4],
        observed_at: args[5],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO legal_dataset_archive')) {
      if (!this.archives.some((a) => a.content_hash === args[0]))
        this.archives.push({
          content_hash: args[0],
          original_bytes_base64: args[1],
          observed_at: args[2],
        });
      return rows([]);
    }
    if (sql.startsWith('SELECT original_bytes_base64'))
      return rows(this.archives.filter((a) => a.content_hash === args[0]));
    if (sql.startsWith('SELECT source,scope,manifest,complete'))
      return rows(this.receipts.filter((a) => a.id === args[0]));
    if (sql.startsWith('SELECT document_kind')) return rows(this.retained);
    if (sql.startsWith('UPDATE state_bill SET')) {
      if (this.s.bill.inventory !== null) return { rows: [], rowCount: 0 };
      this.s.bill.inventory = JSON.parse(args[0]);
      if (this.corruptProtected) this.s.bill.protected_hash = 'changed';
      return { rows: [], rowCount: 1 };
    }
    throw Error('UNHANDLED_TEST_SQL ' + sql);
  }
}
async function setup() {
  const bytes = await zip(),
    db = new DB(),
    e = env();
  e.HB1211_DATASET_APPROVED_PLAN = r.hash(r.previewPlan(db.s, 30000, BINDING));
  let calls = [];
  const deps = {
    parseDatasetZip,
    reportSourceFacts,
    getDatasetList: async (key, state) => {
      calls.push(['list', state]);
      return [
        {
          session_id: 2220,
          dataset_hash: 'provider-dataset-hash',
          dataset_date: '2026-10-01',
          access_key: 'private-access-key',
        },
      ];
    },
    getDataset: async (key, id, access) => {
      calls.push(['dataset', id]);
      return {
        session_id: 2220,
        dataset_hash: 'provider-dataset-hash',
        dataset_date: '2026-10-01',
        zip: bytes.toString('base64'),
      };
    },
  };
  return { db, e, deps, calls, bytes };
}
test('uses unchanged hard cap beyond soft budget, refuses over-cap reservations', () => {
  assert.equal(r.previewPlan(snap(), 30000, BINDING).reservedMaximum, 8);
  const s = snap();
  s.usage.used = 29993;
  assert.throws(() => r.previewPlan(s, 30000, BINDING), /HARD_CAP_HOLD/);
  assert.throws(() => r.environment({ ...env(), LEGISCAN_HARD_CAP: '30001' }), /INVALID/);
});
test('canonical JSON hashes survive PostgreSQL jsonb key reordering', () =>
  assert.equal(r.hash({ z: 1, a: { z: 2, a: 3 } }), r.hash({ a: { a: 3, z: 2 }, z: 1 })));
test('runtime requires explicit injected SHA/image and binds both into review plan', () => {
  for (const override of [
    { HB1211_DATASET_SOURCE_SHA: undefined },
    { GIT_SHA: 'c'.repeat(40) },
    { RELEASE_SHA: 'c'.repeat(40) },
    { HB1211_DATASET_IMAGE: undefined },
    { HB1211_DATASET_IMAGE: 'mutable:latest' },
  ])
    assert.throws(() => r.environment({ ...env(), ...override }));
  const a = r.previewPlan(snap(), 30000, BINDING),
    b = r.previewPlan(snap(), 30000, { ...BINDING, image: IMAGE.replace('sha256:b', 'sha256:c') });
  assert.notEqual(r.hash(a), r.hash(b));
  assert.equal(a.sourceSha, SOURCE);
  assert.equal(a.image, IMAGE);
});
test('rejects expired approval and every exact identity/scope drift', () => {
  assert.throws(
    () =>
      r.approval(
        { HB1211_DATASET_APPROVED_PLAN: 'x', HB1211_DATASET_EXPIRES_AT: '2020-01-01' },
        'x',
      ),
    /EXPIRED/,
  );
  for (const mutate of [
    (s) => (s.bill.legiscan_change_hash = 'new'),
    (s) => s.sessions.push({ legiscan_session_id: 2 }),
    (s) => (s.cursor.session_key = '2025'),
    (s) => (s.permissions[0].allowed = false),
    (s) => (s.bill.inventory = {}),
  ]) {
    const s = snap();
    mutate(s);
    assert.throws(() => r.previewPlan(s, 30000, BINDING));
  }
});
test('rejects missing/duplicate dataset listing and session/hash/date/base64 mismatch', () => {
  assert.throws(() => r.selectListing([]));
  assert.throws(() => r.selectListing([{ session_id: 2220 }, { session_id: 2220 }]));
  for (const result of [
    { session_id: 2 },
    { session_id: 2220, dataset_hash: 'other' },
    { session_id: 2220, dataset_hash: 'h', dataset_date: 'other' },
    { session_id: 2220, dataset_hash: 'h', dataset_date: 'd', zip: '!!!' },
  ])
    assert.throws(() => r.decodeDataset({ dataset_hash: 'h', dataset_date: 'd' }, result));
});
test('real qualified ZIP parser and facts helper derive complete one-bill inventory', async () => {
  const parsed = await parseDatasetZip(await zip());
  const i = r.qualifyParsed(parsed, reportSourceFacts, '2026-10-01T00:00:00.000Z', {});
  assert.deepEqual(i.expected, [
    { kind: 'text', providerId: 42, providerHash: 'original-text-hash' },
  ]);
});
test('real parser skips, duplicate bill, partial list, wrong session/hash and duplicate documents fail closed', async () => {
  const variants = [
    await zip([raw()], (z) => z.file('FL/2026/bill/bad.json', '{broken')),
    await zip([raw(), raw()]),
  ];
  for (const bytes of variants) {
    const p = await parseDatasetZip(bytes);
    assert.throws(() => r.qualifyParsed(p, reportSourceFacts, '2026-10-01', {}));
  }
  for (const mutate of [
    (b) => delete b.supplements,
    (b) => (b.change_hash = 'other'),
    (b) => (b.session.session_id = 2),
    (b) => b.texts.push({ ...b.texts[0] }),
    (b) => (b.texts[0].text_hash = null),
  ]) {
    const b = raw();
    mutate(b);
    assert.throws(() =>
      r.qualifyParsed(
        { bills: [b], skipped: { bills: 0, people: 0, votes: 0 } },
        reportSourceFacts,
        '2026-10-01',
        {},
      ),
    );
  }
});
test('retrieval reserves eight before exactly two operations, stores full archive and does not write bill', async () => {
  const { db, e, deps, calls } = await setup();
  const result = await r.retrieve(db, deps, e);
  assert.deepEqual(calls, [
    ['list', 'FL'],
    ['dataset', 2220],
  ]);
  assert.equal(db.s.usage.used, 28011);
  assert.equal(db.s.bill.inventory, null);
  assert.equal(result.billWrites, 0);
  assert.equal(db.archives.length, 1);
  assert.equal(result.missingDocuments.length, 1);
  assert.equal(db.receipts.length, 2);
  assert.ok(!JSON.stringify(result).includes('private-access-key'));
});
test('pre-existing archive preserves original observed time, separate from new retrieval time', async () => {
  const { db, e, deps, bytes } = await setup();
  db.archives.push({
    content_hash: r.bytesHash(bytes),
    original_bytes_base64: bytes.toString('base64'),
    observed_at: '2026-09-20T01:02:03.000Z',
  });
  const result = await r.retrieve(db, deps, e);
  assert.equal(result.applyPlan.inventory.observedAt, '2026-09-20T01:02:03.000Z');
  assert.notEqual(
    result.applyPlan.inventory.provenance.retrievedAt,
    result.applyPlan.inventory.observedAt,
  );
});
test('fresh reservation recheck blocks concurrent quota increase before provider requests', async () => {
  const { db, e, deps, calls } = await setup();
  const original = db.query.bind(db);
  db.query = async (sql, args) => {
    if (sql.includes('pg_advisory_xact_lock')) db.s.usage.used = 29999;
    return original(sql, args);
  };
  await assert.rejects(r.retrieve(db, deps, e), /HARD_CAP_HOLD/);
  assert.equal(calls.length, 0);
  assert.equal(db.receipts.length, 0);
});
test('provider failure retains conservative reservation and never retries at operator level', async () => {
  const { db, e, deps } = await setup();
  let calls = 0;
  deps.getDatasetList = async () => {
    calls++;
    throw Error('PROVIDER_FAILED');
  };
  await assert.rejects(r.retrieve(db, deps, e), /^Error: HB1211_DATASET_LIST_UNEXPECTED_FAILURE$/);
  assert.equal(calls, 1);
  assert.equal(db.s.usage.used, 28011);
  assert.equal(db.receipts.length, 1);
  assert.equal(db.s.bill.inventory, null);
});
test('known running legacy owner blocks retrieval without changing its schedule or spending quota', async () => {
  const { db, e, deps, calls } = await setup();
  db.s.activeLegacy = [{ source: 'sync-legiscan-masterlist' }];
  await assert.rejects(r.retrieve(db, deps, e), /LEGACY_PROVIDER_OWNER_RUNNING/);
  assert.equal(calls.length, 0);
  assert.equal(db.s.usage.used, 28003);
});
test('dataset failure after reservation retains charge but never archives unqualified inventory', async () => {
  const { db, e, deps } = await setup();
  deps.getDataset = async () => ({ session_id: 2220, dataset_hash: 'wrong', zip: 'eA==' });
  await assert.rejects(r.retrieve(db, deps, e), /DATASET_REVISION_MISMATCH/);
  assert.equal(db.s.usage.used, 28011);
  assert.equal(db.archives.length, 0);
  assert.equal(db.receipts.length, 1);
});
test('apply reparses retained archive, updates only missing inventory, matches retained hashes, makes zero provider calls', async () => {
  const { db, e, deps, calls } = await setup();
  const candidate = await r.retrieve(db, deps, e);
  db.retained = [{ document_kind: 'text', provider_id: '42', provider_hash: 'original-text-hash' }];
  e.HB1211_DATASET_APPROVED_PLAN = candidate.planHash;
  e.HB1211_DATASET_CANDIDATE_ID = candidate.candidateId;
  const result = await r.apply(db, deps, e);
  assert.equal(result.providerRequests, 0);
  assert.equal(result.missingDocuments.length, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(db.s.bill.inventory, candidate.applyPlan.inventory);
  assert.equal(db.s.bill.protected_hash, 'canonical-protected');
  assert.equal(db.s.usage.used, 28011);
  await assert.rejects(r.apply(db, deps, e), /MISSING_INVENTORY_ONLY/);
});
test('apply refuses canonical drift and archive corruption; protected trigger change rolls back inventory', async () => {
  for (const kind of ['canonical', 'archive', 'trigger']) {
    const { db, e, deps } = await setup();
    const c = await r.retrieve(db, deps, e);
    e.HB1211_DATASET_APPROVED_PLAN = c.planHash;
    e.HB1211_DATASET_CANDIDATE_ID = c.candidateId;
    if (kind === 'canonical') db.s.bill.protected_hash = 'changed';
    if (kind === 'archive') db.archives[0].original_bytes_base64 = 'Y29ycnVwdA==';
    if (kind === 'trigger') db.corruptProtected = true;
    await assert.rejects(r.apply(db, deps, e));
    assert.equal(db.s.bill.inventory, null);
    assert.equal(db.receipts.length, 2);
  }
});

test('provider failures identify the stage without exposing credentials or arbitrary response text', async () => {
  const { providerStep } = require('./runtime.cjs');
  for (const [error, expected] of [
    [new Error('LegiScan HTTP 403 for op=getDataset'), 'HTTP_403'],
    [new Error('LegiScan op=getDataset status=ERROR: secret-access-key'), 'PROVIDER_REJECTED'],
    [Object.assign(new Error('https://provider/?key=secret'), { name: 'TimeoutError' }), 'TIMEOUT'],
    [new Error('request to https://provider/?key=secret failed'), 'UNEXPECTED_FAILURE'],
    [new Error('PRIVATE_API_ACCESS_KEY'), 'UNEXPECTED_FAILURE'],
  ]) {
    await assert.rejects(providerStep('DATASET_DOWNLOAD', async () => { throw error; }), { message: 'HB1211_DATASET_DOWNLOAD_' + expected });
  }
  assert.equal(await providerStep('DATASET_LIST', async () => 7), 7);
});
