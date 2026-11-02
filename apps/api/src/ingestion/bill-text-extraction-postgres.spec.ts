/** Standalone synthetic schema: the forward migration runs without touching application data. */
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { ensureBillTextExtraction } from './bill-text-extraction';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { structureText } from './bill-document-structure';
import { passages, CHUNKER_VERSION, passageMetadata } from './bill-text-passages';

describe('structured extraction migration on isolated PostgreSQL', () => {
  jest.setTimeout(60000);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  let prisma: PrismaClient;
  const schema = 'bill_fixture_' + randomUUID().replace(/-/g, '');
  const revision = randomUUID(),
    extraction = randomUUID(),
    documentHash = 'a'.repeat(64);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (
      process.env.CAPIRO_DISPOSABLE_PG !== '1' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname != '/bill_structured_test'
    )
      throw Error('DISPOSABLE_BILL_DATABASE_REQUIRED');
    await db.connect();
    url.searchParams.set('schema', schema);
    prisma = new PrismaClient({ datasources: { db: { url: url.href } } });
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;
      CREATE TABLE public.congress_bill(id text PRIMARY KEY);
      INSERT INTO public.congress_bill VALUES('119-hr-1');
      CREATE TABLE public.federal_evidence_revision(id uuid PRIMARY KEY,collection text,content_hash text,bill_id text DEFAULT '119-hr-1');
      CREATE TABLE public.state_bill_published_record(id uuid PRIMARY KEY,kind text,evidence jsonb);
      CREATE TABLE context_embeddings(model text,content_hash text,tenant_id uuid,client_id uuid,owner_user_id uuid,source_type text);
      CREATE FUNCTION legiwatch_reject_record_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN CREATE ROLE capiro_app; END IF; END $$;`);
    await db.query(
      readFileSync(
        resolve(
          process.cwd(),
          'prisma/migrations/20281102010000_bill_structured_extractions/migration.sql',
        ),
        'utf8',
      ),
    );
    await db.query(
      "INSERT INTO public.federal_evidence_revision(id,collection,content_hash) VALUES($1,'BILLS',$2)",
      [revision, documentHash],
    );
    await db.query(
      `GRANT USAGE ON SCHEMA ${schema} TO capiro_app; GRANT SELECT ON public.congress_bill,public.federal_evidence_revision,public.state_bill_published_record TO capiro_app`,
    );
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    if (db) {
      await db.query(`RESET ROLE; DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await db.end();
    }
  });
  const insert = async (
    id: string,
    owner: string,
    kind = 'federal',
    hash = documentHash,
    status = 'complete',
    text = 'SECTION 1. A',
    structureHash = sha(text),
  ) =>
    db.query(
      `INSERT INTO bill_text_extraction
   (id,source_kind,revision_id,parser_version,document_hash,text_hash,structure_hash,extracted_text,structure_jsonb,completeness)
   VALUES($1,$2,$3,'bill-structure-v1',$4,$5,$6,$7,'{}',$8)`,
      [id, kind, owner, hash, sha(text), structureHash, text, status],
    );
  it('enforces owner kind and original hash and retains retry history without updates', async () => {
    await expect(insert(randomUUID(), randomUUID())).rejects.toThrow(
      'BILL_EXTRACTION_OWNER_MISMATCH',
    );
    await expect(insert(randomUUID(), revision, 'state')).rejects.toThrow(
      'BILL_EXTRACTION_OWNER_MISMATCH',
    );
    await expect(insert(randomUUID(), revision, 'federal', 'b'.repeat(64))).rejects.toThrow(
      'BILL_EXTRACTION_OWNER_MISMATCH',
    );
    await insert(randomUUID(), revision, 'federal', documentHash, 'failed', '', 'f'.repeat(64));
    await insert(extraction, revision);
    await expect(insert(randomUUID(), revision)).rejects.toThrow(/unique constraint/);
    await expect(
      db.query("UPDATE bill_text_extraction SET completeness='failed' WHERE id=$1", [extraction]),
    ).rejects.toThrow('immutable');
    await expect(
      db.query('DELETE FROM bill_text_extraction WHERE id=$1', [extraction]),
    ).rejects.toThrow('immutable');
    expect(
      (
        await db.query('SELECT completeness FROM bill_text_extraction ORDER BY created_at')
      ).rows.map((r) => r.completeness),
    ).toEqual(['failed', 'complete']);
  });
  it('accepts an immutable published-law version owner without relabeling its collection', async () => {
    const law = randomUUID();
    await db.query(
      "INSERT INTO public.federal_evidence_revision(id,collection,content_hash) VALUES($1,'PLAW',$2)",
      [law, documentHash],
    );
    await expect(insert(randomUUID(), law)).resolves.toBeDefined();
    const unbound = randomUUID();
    await db.query(
      "INSERT INTO public.federal_evidence_revision(id,collection,content_hash,bill_id) VALUES($1,'PLAW',$2,NULL)",
      [unbound, documentHash],
    );
    await expect(insert(randomUUID(), unbound)).rejects.toThrow('BILL_EXTRACTION_OWNER_MISMATCH');
  });
  it('indexes long text and every tiny heading without any vectors, with exact UTF16 slices', async () => {
    const body =
      'SECTION 1. A\n(a) ' +
      'A long appropriation 😀 sentence. '.repeat(40000) +
      '\nSECTION 2. Quokka';
    const structure = structureText(body),
      id = randomUUID();
    await insert(
      id,
      revision,
      'federal',
      documentHash,
      'complete',
      structure.text,
      structure.structureHash,
    );
    const rows = passages(structure.sections).map((c) => ({
      ordinal: c.ordinal,
      start_offset: c.start,
      end_offset: c.end,
      content_text: c.text,
      metadata_jsonb: passageMetadata(c),
    }));
    await db.query(
      `INSERT INTO bill_text_passage(extraction_id,chunker_version,ordinal,start_offset,end_offset,content_text,metadata_jsonb)
     SELECT $1,$2,p.ordinal,p.start_offset,p.end_offset,p.content_text,p.metadata_jsonb FROM jsonb_to_recordset($3::jsonb)
     AS p(ordinal int,start_offset int,end_offset int,content_text text,metadata_jsonb jsonb)`,
      [id, CHUNKER_VERSION, JSON.stringify(rows)],
    );
    const found = await db.query(
      `SELECT content_text FROM bill_text_passage WHERE extraction_id=$1 AND search_vector @@ plainto_tsquery('english','quokka')`,
      [id],
    );
    expect(found.rows).toEqual([{ content_text: 'SECTION 2. Quokka' }]);
    expect(
      (await db.query('SELECT count(*)::int n FROM bill_text_passage WHERE extraction_id=$1', [id]))
        .rows[0].n,
    ).toBe(rows.length);
    for (const row of rows)
      expect(structure.text.slice(row.start_offset, row.end_offset)).toBe(row.content_text);
    await expect(
      db.query("UPDATE bill_text_passage SET content_text='changed' WHERE extraction_id=$1", [id]),
    ).rejects.toThrow('immutable');
  });
  it('indexes only exact-model public bill hash reuse', async () => {
    const index = (
      await db.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='context_embeddings_bill_passage_hash_idx'`,
        [schema],
      )
    ).rows[0].indexdef;
    expect(index).toContain('(model, content_hash)');
    expect(index).toContain('tenant_id IS NULL');
    expect(index).toContain('client_id IS NULL');
    expect(index).toContain('owner_user_id IS NULL');
    expect(index).toContain('bill_passage');
    expect(index).toContain('state_bill_passage');
  });
  it('runs the actual Prisma writer through failed conflict, completed extraction, and idempotent reuse', async () => {
    const body = 'SECTION 5. Definitions\n(a) “Office” means the synthetic office.';
    const owner = randomUUID(),
      hash = sha(body);
    await db.query(
      "INSERT INTO public.federal_evidence_revision(id,collection,content_hash) VALUES($1,'BILLS',$2)",
      [owner, hash],
    );
    const input = {
      sourceKind: 'federal' as const,
      revisionId: owner,
      documentHash: hash,
      format: 'txt',
    };
    const failed = await ensureBillTextExtraction(prisma, input, { commit: true });
    const repeatedFailure = await ensureBillTextExtraction(prisma, input, { commit: true });
    expect(failed.completeness).toBe('failed');
    expect(repeatedFailure.id).toBe(failed.id);
    const success = await ensureBillTextExtraction(
      prisma,
      { ...input, rawContent: body },
      { commit: true },
    );
    expect(success.completeness).toBe('complete');
    expect(success.id).not.toBe(failed.id);
    expect(
      (await ensureBillTextExtraction(prisma, { ...input, rawContent: body }, { commit: true })).id,
    ).toBe(success.id);
    const chunks = (
      await db.query(
        'SELECT start_offset,end_offset,content_text FROM bill_text_passage WHERE extraction_id=$1 ORDER BY ordinal',
        [success.id],
      )
    ).rows;
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks)
      expect(success.structure.text.slice(chunk.start_offset, chunk.end_offset)).toBe(
        chunk.content_text,
      );
  });
  it('grants runtime read/insert while denying rewrite, deletion and truncate', async () => {
    await db.query('SET ROLE capiro_app');
    try {
      expect(
        (await db.query('SELECT count(*)::int n FROM bill_text_extraction')).rows[0].n,
      ).toBeGreaterThan(1);
      await expect(db.query('TRUNCATE bill_text_passage')).rejects.toThrow(/permission denied/);
      await expect(db.query('DELETE FROM bill_text_extraction')).rejects.toThrow(
        /permission denied/,
      );
      await insert(
        randomUUID(),
        revision,
        'federal',
        documentHash,
        'partial',
        'Retriable partial text.',
      );
    } finally {
      await db.query('RESET ROLE');
    }
  });
});
