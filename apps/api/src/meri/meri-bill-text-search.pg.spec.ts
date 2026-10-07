import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  BILL_TEXT_PASSAGE_SEARCH_SQL,
  groupBillTextSearchRows,
  type BillTextSearchRow,
} from './meri-bill-text-search.js';

// The production migration, applied verbatim onto the minimal owner tables it
// depends on (the real ones come from 20280924030000_federal_legislative_evidence).
const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20281008040000_federal_evidence_passage_search/migration.sql',
  ),
  'utf8',
);

const PRE_MIGRATION = `
CREATE ROLE capiro_app;
CREATE FUNCTION legiwatch_reject_record_rewrite() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'record rewrite rejected'; END $$;
CREATE TABLE federal_evidence_revision (
  id UUID PRIMARY KEY,
  collection VARCHAR(16) NOT NULL,
  bill_id TEXT,
  version_code VARCHAR(32),
  extraction_hash CHAR(64) NOT NULL,
  extracted_text TEXT NOT NULL,
  completeness VARCHAR(16) NOT NULL
);
CREATE VIEW federal_evidence_current AS
  SELECT 'present'::TEXT AS state, r.id AS revision_id, r.collection, r.bill_id, r.version_code
    FROM federal_evidence_revision r;
CREATE TABLE congress_bill (id TEXT PRIMARY KEY, title TEXT);
`;

const filler = (n: number) => 'General provisions apply to this Act. '.repeat(n);
let sequence = 0;
function revisionId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

async function insertRevision(
  db: PGlite,
  billId: string,
  text: string,
  options: { collection?: string; completeness?: string } = {},
): Promise<string> {
  const id = revisionId();
  await db.query(
    `INSERT INTO federal_evidence_revision
       (id, collection, bill_id, version_code, extraction_hash, extracted_text, completeness)
     VALUES ($1, $2, $3, 'ih', $4, $5, $6)`,
    [
      id,
      options.collection ?? 'BILLS',
      billId,
      'c'.repeat(64),
      text,
      options.completeness ?? 'complete',
    ],
  );
  return id;
}

describe('federal evidence passage search (PGlite)', () => {
  let db: PGlite;
  let preexisting: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(PRE_MIGRATION);
    // Stored before the migration: the migration's fill must index it.
    preexisting = await insertRevision(
      db,
      '119-hr-10',
      `${filler(50)} The Secretary shall maintain the gallium reserve. ${filler(50)}`,
    );
    await db.exec(MIGRATION);
    await db.query(`INSERT INTO congress_bill (id, title) VALUES ('119-hr-20', 'Hypersonics Act')`);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it('indexes revisions stored before the migration and new ones through the trigger', async () => {
    const text = filler(300); // about 11,400 characters: windows at 0, 3600, 7200 and 10800
    const id = await insertRevision(db, '119-hr-20', text);
    const passages = await db.query<{ ordinal: number; start_offset: number; end_offset: number }>(
      'SELECT ordinal, start_offset, end_offset FROM federal_evidence_passage WHERE revision_id = $1 ORDER BY ordinal',
      [id],
    );
    expect(passages.rows.map((row) => row.start_offset)).toEqual([0, 3600, 7200, 10800]);
    expect(passages.rows.at(-1)?.end_offset).toBe(text.length);
    const old = await db.query('SELECT 1 FROM federal_evidence_passage WHERE revision_id = $1', [
      preexisting,
    ]);
    expect(old.rows.length).toBeGreaterThan(0);
  });

  it('skips other collections and incomplete revisions', async () => {
    const report = await insertRevision(db, null as unknown as string, filler(10), {
      collection: 'CRPT',
    });
    const partial = await insertRevision(db, '119-s-30', filler(10), { completeness: 'partial' });
    const rows = await db.query(
      'SELECT 1 FROM federal_evidence_passage WHERE revision_id = ANY($1::uuid[])',
      [[report, partial]],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('finds a phrase that straddles a window boundary and groups results by bill', async () => {
    // Place the phrase across offset 3,600: the second window starts there and
    // the first ends at 4,000, so the overlap keeps the phrase whole.
    const before = 'x'.repeat(3_580);
    const text = `${before} hypersonic glide body testing program ${filler(200)}`;
    await insertRevision(db, '119-hr-20', text);
    const result = await db.query<BillTextSearchRow>(BILL_TEXT_PASSAGE_SEARCH_SQL, [
      '"hypersonic glide body"',
      119,
      8,
      0,
    ]);
    const grouped = groupBillTextSearchRows(result.rows);
    expect(grouped.map((bill) => bill.billId)).toEqual(['119-hr-20']);
    expect(grouped[0]?.title).toBe('Hypersonics Act');
    expect(grouped[0]?.passages[0]?.snippet).toContain('«hypersonic»');
  });

  it('filters by Congress and returns nothing for an absent term', async () => {
    const other = await db.query<BillTextSearchRow>(BILL_TEXT_PASSAGE_SEARCH_SQL, [
      'gallium',
      118,
      8,
      0,
    ]);
    expect(other.rows).toHaveLength(0);
    const found = await db.query<BillTextSearchRow>(BILL_TEXT_PASSAGE_SEARCH_SQL, [
      'gallium',
      null,
      8,
      0,
    ]);
    expect(found.rows.map((row) => row.billId)).toEqual(['119-hr-10']);
    const none = await db.query(BILL_TEXT_PASSAGE_SEARCH_SQL, ['quantum', null, 8, 0]);
    expect(none.rows).toHaveLength(0);
  });

  it('pages by bill with the exact number of matching bills on every row', async () => {
    for (const bill of ['119-hr-31', '119-hr-32', '119-hr-33']) {
      await insertRevision(
        db,
        bill,
        `${filler(5)} The tungsten stockpile is maintained. ${filler(5)}`,
      );
    }
    const first = await db.query<BillTextSearchRow>(BILL_TEXT_PASSAGE_SEARCH_SQL, [
      'tungsten',
      119,
      2,
      0,
    ]);
    const firstBills = [...new Set(first.rows.map((row) => row.billId))];
    expect(firstBills).toHaveLength(2);
    expect(first.rows.every((row) => row.totalBills === 3)).toBe(true);
    const second = await db.query<BillTextSearchRow>(BILL_TEXT_PASSAGE_SEARCH_SQL, [
      'tungsten',
      119,
      2,
      2,
    ]);
    const secondBills = [...new Set(second.rows.map((row) => row.billId))];
    expect(secondBills).toHaveLength(1);
    expect([...firstBills, ...secondBills].sort()).toEqual(['119-hr-31', '119-hr-32', '119-hr-33']);
    const past = await db.query(BILL_TEXT_PASSAGE_SEARCH_SQL, ['tungsten', 119, 2, 4]);
    expect(past.rows).toHaveLength(0);
  });

  it('keeps passages insert-only', async () => {
    await expect(
      db.query('UPDATE federal_evidence_passage SET ordinal = ordinal WHERE revision_id = $1', [
        preexisting,
      ]),
    ).rejects.toThrow('record rewrite rejected');
  });
});
