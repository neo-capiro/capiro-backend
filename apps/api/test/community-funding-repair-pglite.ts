/**
 * PGlite-backed integration test for CPF/CDS geography repair.
 *
 * Run from the repository root:
 *   node --import ./apps/api/node_modules/tsx/dist/esm/index.mjs apps/api/test/community-funding-repair-pglite.ts
 *
 * Verifies:
 *   - Dry-run counts are exact
 *   - Commit with wrong expected count refuses and writes nothing
 *   - Commit with right count repairs exactly the eligible rows
 *   - A second run is a no-op (idempotent)
 *   - Amounts are byte-identical before/after
 *   - No rows are created or deleted
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { classifyGeographyRepair } from '../src/government-data/community-funding/community-funding.geography-repair.js';

const requireTestModule = createRequire(resolve(import.meta.dirname, '../package.json'));
const PGliteModule = process.env.LEGIWATCH_PGLITE_MODULE ?? '@electric-sql/pglite';
const { PGlite } = requireTestModule(PGliteModule);
const migrationPath = resolve(
  import.meta.dirname,
  '../prisma/migrations/20280101030000_cpf_cds_canonical_ingestion/migration.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

const sourceDocumentDDL = `
CREATE TABLE source_document (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_key TEXT NOT NULL,
  sha256 CHAR(64),
  UNIQUE(source_key, sha256)
);
`;

async function main() {
  const db = await PGlite.create();
  let checks = 0;

  const reset = async () => {
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await db.exec(sourceDocumentDDL);
    await db.exec(migration);
  };

  const query = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;
  const exec = async (sql: string, values: unknown[] = []) => db.query(sql, values);

  const pass = (name: string) => {
    checks++;
    console.log('PASS ' + name);
  };

  try {
    console.log((await db.query('SELECT version() AS version')).rows[0].version);
    await reset();
    pass('schema created');

    const sourceDoc1 = '11111111-1111-1111-1111-111111111111';
    const sourceDoc2 = '22222222-2222-2222-2222-222222222222';
    await exec(
      "INSERT INTO source_document (id, source_key, sha256) VALUES ($1, 'xlsx-fy2026', 'abc'), ($2, 'xlsx-fy2027', 'def')",
      [sourceDoc1, sourceDoc2],
    );

    const insertRequest = async (opts: {
      chamber: 'house' | 'senate';
      identityHash: string;
      fiscalYear: number;
      requesterName: string;
      requesterState?: string | null;
      requesterDistrict?: string | null;
      requestedAmountUsd: string;
      finalAmountUsd?: string | null;
      amountStageRaw: string;
    }) => {
      const requestType = opts.chamber === 'house' ? 'cpf' : 'cds';
      const result = await db.query(
        `INSERT INTO community_funding_request (
          id, identity_hash, chamber, request_type, congress, fiscal_year,
          requester_name, requester_state, requester_district,
          recipient_name, recipient_normalized, city, state,
          project_title, requested_amount_usd, final_amount_usd, amount_stage_raw,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, NULL, $4,
          $5, $6, $7,
          'Test Recipient', 'test recipient', 'Miami', 'FL',
          'Test Project', $8, $9, $10,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ) RETURNING id`,
        [
          opts.identityHash,
          opts.chamber,
          requestType,
          opts.fiscalYear,
          opts.requesterName,
          opts.requesterState ?? null,
          opts.requesterDistrict ?? null,
          opts.requestedAmountUsd,
          opts.finalAmountUsd ?? null,
          opts.amountStageRaw,
        ],
      );
      return result.rows[0].id;
    };

    const insertSource = async (requestId: string, sourceDocId: string, rowNum: number) => {
      await exec(
        `INSERT INTO community_funding_request_source (
          id, request_id, source_document_id, source_page, source_row, source_hash, retrieved_at,
          requester_name_raw, amount_stage_raw, requested_amount_usd, final_amount_usd,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, 1, $3, 'hash', CURRENT_TIMESTAMP,
          'requester', 'amount_requested', 1000, NULL,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )`,
        [requestId, sourceDocId, rowNum],
      );
    };

    // Seed: >400 Senate statewide rows
    console.log('Seeding 420 Senate statewide rows...');
    for (let i = 0; i < 420; i++) {
      await insertRequest({
        chamber: 'senate',
        identityHash: 'senate-row-' + i,
        fiscalYear: 2026,
        requesterName: 'Senator ' + i,
        requesterState: 'NY',
        requesterDistrict: null,
        requestedAmountUsd: '1000',
        amountStageRaw: 'senate_recommendation',
      });
    }
    const senateCount = (await query('SELECT COUNT(*) AS c FROM community_funding_request WHERE chamber = $1', ['senate']))[0].c;
    assert.equal(senateCount, 420);
    pass('seeded ' + senateCount + ' Senate rows');

    // Seed: House rows
    console.log('Seeding House rows...');

    const h1Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-1', fiscalYear: 2026,
      requesterName: 'Rep FL08', requesterState: null, requesterDistrict: 'FL08',
      requestedAmountUsd: '5000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h1Id, sourceDoc1, 1);

    const h2Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-2', fiscalYear: 2026,
      requesterName: 'Rep fl08', requesterState: null, requesterDistrict: 'fl08',
      requestedAmountUsd: '6000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h2Id, sourceDoc1, 2);

    const h3Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-3', fiscalYear: 2026,
      requesterName: 'Rep AK', requesterState: null, requesterDistrict: 'AKAL',
      requestedAmountUsd: '7000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h3Id, sourceDoc1, 3);

    const h4Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-4', fiscalYear: 2026,
      requesterName: 'Rep Normal', requesterState: 'FL', requesterDistrict: '08',
      requestedAmountUsd: '8000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h4Id, sourceDoc1, 4);

    const h5Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-5', fiscalYear: 2026,
      requesterName: 'Rep Conflict', requesterState: 'GA', requesterDistrict: 'FL08',
      requestedAmountUsd: '9000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h5Id, sourceDoc1, 5);

    const h6Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-6', fiscalYear: 2026,
      requesterName: 'Rep Bad', requesterState: null, requesterDistrict: 'FL8',
      requestedAmountUsd: '10000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h6Id, sourceDoc1, 6);

    const h7Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-7', fiscalYear: 2026,
      requesterName: 'Rep NoDist', requesterState: null, requesterDistrict: null,
      requestedAmountUsd: '11000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h7Id, sourceDoc1, 7);

    const houseCount = (await query('SELECT COUNT(*) AS c FROM community_funding_request WHERE chamber = $1', ['house']))[0].c;
    assert.equal(houseCount, 7);
    pass('seeded ' + houseCount + ' House rows');

    const totalCount = (await query('SELECT COUNT(*) AS c FROM community_funding_request'))[0].c;
    assert.equal(totalCount, 427);
    pass('total seeded rows ' + totalCount);

    // Snapshot amounts before repair
    const amountSnapshot = await query(
      'SELECT id, identity_hash, requested_amount_usd, final_amount_usd FROM community_funding_request WHERE chamber = $1 ORDER BY id',
      ['house'],
    );
    pass('amount snapshot taken');

    // Test 1: Dry-run classification
    console.log('\n--- Test: Dry-run classification ---');
    const houseRows = await query(
      'SELECT id, identity_hash, chamber, fiscal_year, requester_state, requester_district FROM community_funding_request WHERE chamber = $1 ORDER BY id',
      ['house'],
    );

    let eligible = 0, already = 0, invalid = 0, conflicting = 0;
    for (const row of houseRows) {
      const cls = classifyGeographyRepair({
        chamber: row.chamber as 'house',
        requesterState: row.requester_state,
        requesterDistrict: row.requester_district,
      });
      if (cls.classification === 'eligible') eligible++;
      else if (cls.classification === 'already_normalized') already++;
      else if (cls.classification === 'invalid') invalid++;
      else if (cls.classification === 'conflicting') conflicting++;
    }

    assert.equal(eligible, 3, 'exactly 3 eligible rows (FL08, fl08, AKAL)');
    assert.equal(already, 1, '1 already_normalized (FL/08)');
    assert.equal(conflicting, 1, '1 conflicting (GA/FL08)');
    assert.equal(invalid, 2, '2 invalid (FL8 malformed, null district)');
    pass('dry-run classification counts exact');

    // Test 2: Commit with wrong expected count refuses
    console.log('\n--- Test: Commit with wrong expected count ---');
    const wrongResult = await performCommit(db, eligible + 1);
    assert.equal(wrongResult.repaired, 0, 'no rows repaired with wrong expected count');
    assert.equal(wrongResult.refused, true, 'commit refused with wrong expected count');
    pass('commit with wrong expected-eligible count REFUSED and wrote nothing');

    // Test 3: Commit with right count repairs exactly eligible
    console.log('\n--- Test: Commit with right expected count ---');
    const rightResult = await performCommit(db, eligible);
    assert.equal(rightResult.repaired, eligible, 'repaired ' + eligible + ' eligible rows');
    assert.equal(rightResult.refused, false, 'commit accepted with right expected count');
    pass('commit with --expected-eligible=' + eligible + ' repaired exactly ' + eligible + ' rows');

    // Test 4: Verify repaired rows
    console.log('\n--- Test: Verify repaired rows ---');

    const checkRow = async (id: string, expectedState: string | null, expectedDistrict: string | null) => {
      const rows = await query(
        'SELECT requester_state, requester_district FROM community_funding_request WHERE id = $1',
        [id],
      );
      assert.equal(rows[0].requester_state, expectedState);
      assert.equal(rows[0].requester_district, expectedDistrict);
    };

    await checkRow(h1Id, 'FL', '08');
    await checkRow(h2Id, 'FL', '08');
    await checkRow(h3Id, 'AK', '00');
    await checkRow(h4Id, 'FL', '08'); // unchanged
    await checkRow(h5Id, 'GA', 'FL08'); // unchanged conflicting
    await checkRow(h6Id, null, 'FL8'); // unchanged invalid
    await checkRow(h7Id, null, null); // unchanged no token

    pass('repaired rows have correct geography');

    // Test 5: Amounts byte-identical
    console.log('\n--- Test: Amounts unchanged ---');
    const amountsAfter = await query(
      'SELECT id, identity_hash, requested_amount_usd, final_amount_usd FROM community_funding_request WHERE chamber = $1 ORDER BY id',
      ['house'],
    );

    for (let i = 0; i < amountSnapshot.length; i++) {
      assert.equal(
        amountsAfter[i].requested_amount_usd,
        amountSnapshot[i].requested_amount_usd,
        'amount unchanged for ' + amountsAfter[i].identity_hash,
      );
      assert.equal(
        amountsAfter[i].final_amount_usd,
        amountSnapshot[i].final_amount_usd,
        'final_amount unchanged for ' + amountsAfter[i].identity_hash,
      );
    }
    pass('amounts byte-identical before and after repair');

    // Test 6: No rows created or deleted
    const countAfter = (await query('SELECT COUNT(*) AS c FROM community_funding_request'))[0].c;
    assert.equal(countAfter, totalCount, 'no rows created or deleted');
    pass('row counts unchanged after repair');

    // Test 7: Second run is idempotent (0 eligible)
    console.log('\n--- Test: Second run idempotency ---');
   const houseRows2 = await query(
      'SELECT id, identity_hash, chamber, fiscal_year, requester_state, requester_district FROM community_funding_request WHERE chamber = $1 ORDER BY id',
      ['house'],
    );

    let eligible2 = 0;
    for (const row of houseRows2) {
      const cls = classifyGeographyRepair({
        chamber: row.chamber as 'house',
        requesterState: row.requester_state,
        requesterDistrict: row.requester_district,
      });
      if (cls.classification === 'eligible') eligible2++;
    }
    assert.equal(eligible2, 0, 'second run reports 0 eligible rows');
    pass('idempotent: second run is a no-op with 0 eligible');

    // Test 8: Senate rows never repaired
    console.log('\n--- Test: Senate rows untouched ---');
    const senateAfter = await query(
      'SELECT COUNT(*) AS c FROM community_funding_request WHERE chamber = $1 AND requester_district IS NOT NULL',
      ['senate'],
    );
    assert.equal(senateAfter[0].c, 0, 'no Senate rows gained a district');
    pass('Senate rows remain statewide (no district assigned)');

    console.log(
      JSON.stringify({
        checks,
        result: 'passed',
        totalRows: totalCount,
        houseRows: houseCount,
        senateRows: senateCount,
        scenariosCovered: [
          '>400 Senate statewide rows',
          'House STDD repair (FL08)',
          'House STDD repair lowercase (fl08)',
          'House at-large repair (AKAL)',
          'already_normalized skipped',
          'conflicting skipped',
          'malformed token skipped (FL8)',
          'null token skipped',
          'wrong expected count refuses',
          'correct expected count commits',
          'amounts byte-identical',
          'no rows created/deleted',
          'second run idempotent',
          'Senate rows never get district',
        ],
      }),
    );
  } finally {
    await db.close();
  }
}

async function performCommit(
  db: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> },
  expectedEligible: number,
): Promise<{ repaired: number; refused: boolean }> {
  const houseRows = await db.query(
    'SELECT id, chamber, requester_state, requester_district FROM community_funding_request WHERE chamber = $1 ORDER BY id',
    ['house'],
  );

  let actualEligible = 0;
  for (const row of houseRows.rows) {
    const cls = classifyGeographyRepair({
      chamber: row.chamber as 'house',
      requesterState: row.requester_state,
      requesterDistrict: row.requester_district,
    });
    if (cls.classification === 'eligible') actualEligible++;
  }

  if (actualEligible !== expectedEligible) {
    return { repaired: 0, refused: true };
  }

  let repaired = 0;
  for (const row of houseRows.rows) {
    const cls = classifyGeographyRepair({
      chamber: row.chamber as 'house',
      requesterState: row.requester_state,
      requesterDistrict: row.requester_district,
    });
    if (cls.classification !== 'eligible') continue;

    await db.query(
      'UPDATE community_funding_request SET requester_state = $1, requester_district = $2 WHERE id = $3',
      [cls.resolvedState, cls.resolvedDistrict, row.id],
    );
    repaired++;
  }

  return { repaired, refused: false };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});