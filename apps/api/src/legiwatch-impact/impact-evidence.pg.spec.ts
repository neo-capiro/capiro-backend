import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import type { Prisma } from '@prisma/client';
import { BILL_EXTRACTION_VERSION, structureText } from '../ingestion/bill-document-structure.js';
import { loadImpactBillEvidence } from './impact-bill-evidence.js';

const describeDb =
  process.env.CAPIRO_DISPOSABLE_PG === '1' && process.env.DATABASE_URL ? describe : describe.skip;
describeDb('impact source SQL on disposable PostgreSQL', () => {
  jest.setTimeout(60_000);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const schema = `impact_evidence_${randomUUID().replace(/-/g, '')}`;
  const stateBill = 'ca-2026-ab123',
    federalBill = '119-hr-123';
  const documentHash = 'a'.repeat(64);
  const tx = {
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await db.query(sql, values)).rows,
  } as Prisma.TransactionClient;
  const structure = structureText(
    'SECTION 1. Domestic components.\nCovered suppliers shall report sourcing.\nSECTION 2. Exception.\nPurchases below $10,000 are excluded.',
  );
  function migrationView(file: string, name: string) {
    const sql = readFileSync(
      resolve(process.cwd(), 'prisma/migrations', file, 'migration.sql'),
      'utf8',
    );
    const match = sql.match(new RegExp(`CREATE VIEW "?${name}"? AS[\\s\\S]+?;`));
    if (!match) throw Error('PRODUCTION_SOURCE_VIEW_MISSING');
    return match[0];
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw Error('DISPOSABLE_LOCAL_POSTGRES_REQUIRED');
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE congress_bill(id text PRIMARY KEY,title text,status text,latest_action_text text,latest_action_date date,url text,update_date_including_text timestamptz,update_date timestamptz);
      CREATE TABLE state_bill(id text PRIMARY KEY,title text,status text,latest_action_text text,latest_action_date date,state_url text,url text,text_date timestamptz);
      CREATE TABLE state_bill_version(bill_key text,legiscan_doc_id integer);
      CREATE TABLE state_bill_published_record(id uuid PRIMARY KEY,bill_key text,kind text,source_identity text,revision_hash text,event_date text,evidence jsonb);
      CREATE TABLE published_record_source_observation(id bigserial PRIMARY KEY,source_key text,state_record_id uuid,official_revision_id uuid,observed_at timestamptz DEFAULT now());
      CREATE TABLE federal_evidence_revision(id uuid PRIMARY KEY,source_key text,provider text,collection text,package_id text,bill_id text,version_code text,lineage_key text,content_hash text,extraction_hash text,source_url text,source_modified_at timestamptz,extracted_text text,completeness text,metadata_jsonb jsonb,published_at timestamptz);
      CREATE TABLE federal_evidence_observation(id bigserial PRIMARY KEY,source_key text,state text,revision_id uuid,observation_key text,observed_at timestamptz DEFAULT now());
      CREATE TABLE bill_text_extraction(id uuid PRIMARY KEY,source_kind text,revision_id uuid,document_hash text,parser_version text,completeness text,text_hash text,structure_hash text,extracted_text text,structure_jsonb jsonb,created_at timestamptz DEFAULT now());
      ${migrationView('20280913019000_legiwatch_source_observations', 'published_record_source_current')}
      ${migrationView('20280924030000_federal_legislative_evidence', 'federal_evidence_current')}`);
    await db.query(
      `INSERT INTO state_bill(id,title,status,latest_action_text,latest_action_date,state_url) VALUES($1,'State fixture','introduced','Introduced','2026-02-01','https://legislature.ca.gov/bill');`,
      [stateBill],
    );
    await db.query(
      `INSERT INTO congress_bill(id,title,status,latest_action_text,latest_action_date,url) VALUES($1,'Federal fixture','introduced','Introduced','2026-02-01','https://congress.gov/bill');`,
      [federalBill],
    );
  });
  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await db.end();
  });
  beforeEach(async () => {
    await db.query(
      'TRUNCATE state_bill_published_record,published_record_source_observation,federal_evidence_revision,federal_evidence_observation,bill_text_extraction,state_bill_version',
    );
  });
  async function stateRevision(sourceIdentity = 'text-one', hash = documentHash) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO state_bill_published_record VALUES($1,$2,'document',$3,$4,'2026-02-01',$5::jsonb)`,
      [
        id,
        stateBill,
        sourceIdentity,
        hash,
        JSON.stringify({
          documentKind: 'text',
          versionType: 'Introduced',
          url: 'https://legislature.ca.gov/bill/text',
          contentHash: hash,
          structure,
        }),
      ],
    );
    await db.query(
      'INSERT INTO published_record_source_observation(source_key,state_record_id) VALUES($1,$2)',
      [`state:${stateBill}:document:${sourceIdentity}`, id],
    );
    return id;
  }
  async function federalRevision(hash = documentHash) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO federal_evidence_revision(id,source_key,provider,collection,package_id,bill_id,version_code,lineage_key,content_hash,extraction_hash,source_url,extracted_text,completeness,metadata_jsonb,published_at)
      VALUES($1,'govinfo:BILLS-119hr123ih','govinfo','BILLS','BILLS-119hr123ih',$2,'ih','119hr123',$3,$3,'https://govinfo.gov/content/pkg/BILLS-119hr123ih/xml/BILLS-119hr123ih.xml',$4,'complete',$5::jsonb,'2026-02-01')`,
      [id, federalBill, hash, structure.text, JSON.stringify({ billStructure: structure })],
    );
    await db.query(
      `INSERT INTO federal_evidence_observation(source_key,state,revision_id,observation_key) VALUES('govinfo:BILLS-119hr123ih','present',$1::uuid,$1::text)`,
      [id],
    );
    return id;
  }
  it('reads all-state current immutable revisions, and a newer observation replaces an older one', async () => {
    const old = await stateRevision(),
      current = await stateRevision('text-one', 'b'.repeat(64));
    const result = await loadImpactBillEvidence(tx, stateBill, new Set());
    expect(result.versions.map((v) => v.id)).toEqual([current]);
    expect(result.versions.some((v) => v.id === old)).toBe(false);
    expect(result.provisions.map((p) => p.text)).toEqual(structure.sections.map((s) => s.text));
    expect((await loadImpactBillEvidence(tx, 'ca-2026-ab999', new Set())).versions).toEqual([]);
  });
  it('uses only the extraction with matching immutable source hash and current parser', async () => {
    const revision = await stateRevision();
    const wrong = structureText('Unrelated document must never be attached to this bill.');
    await db.query(
      `INSERT INTO bill_text_extraction VALUES($1,'state',$2,$3,$4,'complete',$5,$6,$7,$8::jsonb,now())`,
      [
        randomUUID(),
        revision,
        'b'.repeat(64),
        BILL_EXTRACTION_VERSION,
        wrong.textHash,
        wrong.structureHash,
        wrong.text,
        JSON.stringify(wrong),
      ],
    );
    let result = await loadImpactBillEvidence(tx, stateBill, new Set());
    expect(result.provisions.some((p) => p.text.includes('Unrelated'))).toBe(false);
    await db.query(
      `INSERT INTO bill_text_extraction VALUES($1,'state',$2,$3,$4,'complete',$5,$6,$7,$8::jsonb,now())`,
      [
        randomUUID(),
        revision,
        documentHash,
        BILL_EXTRACTION_VERSION,
        structure.textHash,
        structure.structureHash,
        structure.text,
        JSON.stringify(structure),
      ],
    );
    result = await loadImpactBillEvidence(tx, stateBill, new Set());
    expect(result.versions[0]?.completeness).toBe('complete');
    expect(result.provisions.map((p) => p.text)).toEqual(structure.sections.map((s) => s.text));
  });
  it('respects federal source removals, reinstatement, and distinct bill identities', async () => {
    const revision = await federalRevision();
    expect(
      (await loadImpactBillEvidence(tx, federalBill, new Set())).versions.map((v) => v.id),
    ).toEqual([revision]);
    await db.query(
      `INSERT INTO federal_evidence_observation(source_key,state,revision_id,observation_key) VALUES('govinfo:BILLS-119hr123ih','removed',$1,'removal')`,
      [revision],
    );
    expect((await loadImpactBillEvidence(tx, federalBill, new Set())).provisions).toEqual([]);
    await db.query(
      `INSERT INTO federal_evidence_observation(source_key,state,revision_id,observation_key) VALUES('govinfo:BILLS-119hr123ih','present',$1,'reinstatement')`,
      [revision],
    );
    expect((await loadImpactBillEvidence(tx, federalBill, new Set())).provisions).toHaveLength(
      structure.sections.length,
    );
    expect((await loadImpactBillEvidence(tx, stateBill, new Set())).provisions).toEqual([]);
  });

  it('reports publisher-listed state versions awaiting source hydration', async () => {
    await stateRevision();
    await db.query('INSERT INTO state_bill_version VALUES($1,123456)', [stateBill]);
    const notes = new Set<string>();
    await loadImpactBillEvidence(tx, stateBill, notes);
    expect([...notes]).toEqual(
      expect.arrayContaining([expect.stringContaining('awaiting retained source text')]),
    );
  });
});
