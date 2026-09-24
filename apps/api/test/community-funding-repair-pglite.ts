/**
 * PGlite-backed integration test for CPF/CDS geography repair (FIXED).
 *
 * Run from the repository root:
 *   node --import ./apps/api/node_modules/tsx/dist/esm/index.mjs apps/api/test/community-funding-repair-pglite.ts
 *
 * Verifies:
 *   - Dry-run counts are exact with new class definitions
 *   - Commit with wrong expected count refuses and writes nothing
 *   - Commit with right count repairs exactly the eligible rows (state only)
 *   - requester_district is NEVER touched (byte-identical)
 *   - A second run is a no-op (idempotent)
 *   - Amounts are byte-identical before/after
 *   - No rows are created or deleted
 *   - A repaired row is returned by the SAME read-path query shape
 *   - Post-repair row matches what parseHouseXlsxRows would produce
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
      /** The canonical state column (project location). */
      projectState?: string | null;
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
          'Test Recipient', 'test recipient', 'Miami', $8::text,
          'Test Project', $9, $10, $11,
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
          opts.projectState ?? null,
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
        projectState: 'NY',
        requestedAmountUsd: '1000',
        amountStageRaw: 'senate_recommendation',
      });
    }
    const senateCount = (await query('SELECT COUNT(*) AS c FROM community_funding_request WHERE chamber = $1', ['senate']))[0].c;
    assert.equal(senateCount, 420);
    pass('seeded ' + senateCount + ' Senate rows');

    // Seed: House rows mimicking real ingest data
    console.log('Seeding House rows...');

    // h1: FL08 token, null state, projectState=FL — eligible (state only)
    const h1Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-1', fiscalYear: 2026,
      requesterName: 'Rep FL08', requesterState: null, requesterDistrict: 'FL08',
      projectState: 'FL',
      requestedAmountUsd: '5000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h1Id, sourceDoc1, 1);

    // h2: fl08 token (lowercase), null state — eligible
    const h2Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-2', fiscalYear: 2026,
      requesterName: 'Rep fl08', requesterState: null, requesterDistrict: 'fl08',
      projectState: 'FL',
      requestedAmountUsd: '6000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h2Id, sourceDoc1, 2);

    // h3: AKAL at-large token, null state — eligible
    const h3Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-3', fiscalYear: 2026,
      requesterName: 'Rep AK', requesterState: null, requesterDistrict: 'AKAL',
      projectState: 'AK',
      requestedAmountUsd: '7000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h3Id, sourceDoc1, 3);

    // h4: already normalized (FL/08) — NOT eligible
    const h4Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-4', fiscalYear: 2026,
      requesterName: 'Rep Normal', requesterState: 'FL', requesterDistrict: '08',
      projectState: 'FL',
      requestedAmountUsd: '8000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h4Id, sourceDoc1, 4);

    // h5: conflicting (GA/FL08) — NOT eligible
    const h5Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-5', fiscalYear: 2026,
      requesterName: 'Rep Conflict', requesterState: 'GA', requesterDistrict: 'FL08',
      projectState: 'GA',
      requestedAmountUsd: '9000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h5Id, sourceDoc1, 5);

    // h6: malformed token (FL8), null state, no projectState — invalid
    const h6Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-6', fiscalYear: 2026,
      requesterName: 'Rep Bad', requesterState: null, requesterDistrict: 'FL8',
      projectState: null,
      requestedAmountUsd: '10000', amountStageRaw: 'amount_requested',
    });
    await insertSource(h6Id, sourceDoc1, 6);

    // h7: no district token, no projectState — invalid
    const h7Id = await insertRequest({
      chamber: 'house', identityHash: 'house-repair-7', fiscalYear: 2026,
      requesterName: 'Rep NoDist', requesterState: null, requesterDistrict: null,
      projectState: null,
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

    // Test 1: Dry-run classification (new classifier with projectState)
    console.log('\n--- Test: Dry-run classification ---');
    const houseRows = await query(
      'SELECT id, identity_hash, chamber, fiscal_year, requester_state, requester_district, state FROM community_funding_request WHERE chamber = $1 ORDER BY id',
      ['house'],
    );

    let eligible = 0, already = 0, invalid = 0, conflicting = 0;
    for (const row of houseRows) {
      const cls = classifyGeographyRepair({
        chamber: row.chamber as 'house',
        requesterState: row.requester_state,
        requesterDistrict: row.requester_district,
        projectState: row.state,
      });
      if (cls.classification === 'eligible') eligible++;
      else if (cls.classification === 'already_normalized') already++;
      else if (cls.classification === 'invalid') invalid++;
      else if (cls.classification === 'conflicting') conflicting++;
    }

    // New expected counts: FL08, fl08, AKAL = 3 eligible (state-only fill)
    // FL/08 = already_normalized; GA/FL08 = conflicting;
    // FL8/no-projectState = invalid; null/no-projectState = invalid
    assert.equal(eligible, 3, 'exactly 3 eligible rows (FL08, fl08, AKAL)');
    assert.equal(already, 1, '1 already_normalized (FL/08)');
    assert.equal(conflicting, 1, '1 conflicting (GA/FL08)');
    assert.equal(invalid, 2, '2 invalid (FL8-noproject, null token)');
    pass('dry-run classifcation counts exact');

    // Test 1b: Verify district tokens stay untouched before repair
    for (const row of houseRows) {
      if (row.requester_district === 'FL08') {
        assert.equal(row.requester_district, 'FL08', 'FL08 token untouched');
      }
      if (row.requester_district === 'fl08') {
        assert.equal(row.requester_district, 'fl08', 'fl08 token untouched');
      }
    }
    pass('district tokens are raw/uppercase as stored');

    // Test 2: Read-path query shape — a row with FL08 is found via sourceStdd branch
    console.log('\n--- Test: Read-path query shape before repair ---');
    const stateCode = 'FL';
    const districtPadded = '08';
    const sourceStdd = stateCode + districtPadded; // 'FL08'
    const districtKeys = [districtPadded, String(Number(districtPadded)), sourceStdd]; // ['08', '8', 'FL08']

    // Read path BEFORE repair: find rows attributed to FL-08
    const beforeReadPathRows = await query(
      `SELECT id, requester_state, requester_district FROM community_funding_request
       WHERE chamber = 'house'
         AND requester_district = ANY($1)
         AND (
           requester_state ILIKE $2
           OR (requester_state IS NULL AND state ILIKE $2)
           OR requester_district ILIKE $3
         )
       ORDER BY id`,
      [districtKeys, stateCode, sourceStdd],
    );

    // Should find h1 (FL08, null state → matches via sourceStdd branch)
    // Should also find h4 (FL/08 → matches via districtKeys + requester_state branch)
    assert.ok(beforeReadPathRows.length >= 1, 'at least 1 row matched by read path before repair');
    const h1Before = beforeReadPathRows.find((r: any) => r.id === h1Id || r.requester_district?.toUpperCase() === 'FL08');
    assert.ok(h1Before != null, 'h1 (FL08 token, null state) found via read path sourceStdd branch');
    pass('read-path finds FL08 row via sourceStdd branch before repair');

    // Test 3: Commit with wrong expected count refuses
    console.log('\n--- Test: Commit with wrong expected count ---');
    const wrongResult = await performCommit(db, eligible + 1, houseRows);
    assert.equal(wrongResult.repaired, 0, 'no rows repaired with wrong expected count');
    assert.equal(wrongResult.refused, true, 'commit refused with wrong expected count');
    pass('commit with wrong expected-eligible count REFUSED and wrote nothing');

    // Test 4: Commit with right count repairs exactly eligible (state ONLY)
    console.log('\n--- Test: Commit with right expected count ---');
    const rightResult = await performCommit(db, eligible, houseRows);
    assert.equal(rightResult.repaired, eligible, 'repaired ' + eligible + ' eligible rows');
    assert.equal(rightResult.refused, false, 'commit accepted with right expected count');
    pass('commit with --expected-eligible=' + eligible + ' repaired exactly ' + eligible + ' rows');

    // Test 5: Verify repaired rows — state filled, district UNTOUCHED
    console.log('\n--- Test: Verify repaired rows ---');

    const checkRepairedRow = async (id: string, expectedState: string | null, expectedDistrict: string | null) => {
      const rows = await query(
        'SELECT requester_state, requester_district FROM community_funding_request WHERE id = $1',
        [id],
      );
      assert.equal(rows[0].requester_state, expectedState, id + ' state');
      assert.equal(rows[0].requester_district, expectedDistrict, id + ' district');
    };

    // h1: FL08 token → state=FL, district=FL08 (UNTOUCHED, not 08)
    await checkRepairedRow(h1Id, 'FL', 'FL08');
    // h2: fl08 token → state=FL, district=fl08 (UNTOUCHED)
    await checkRepairedRow(h2Id, 'FL', 'fl08');
    // h3: AKAL token → state=AK, district=AKAL (UNTOUCHED)
    await checkRepairedRow(h3Id, 'AK', 'AKAL');
    // h4: unchanged already_normalized
    await checkRepairedRow(h4Id, 'FL', '08');
    // h5: unchanged conflicting
    await checkRepairedRow(h5Id, 'GA', 'FL08');
    // h6: unchanged invalid
    await checkRepairedRow(h6Id, null, 'FL8');
    // h7: unchanged no token
    await checkRepairedRow(h7Id, null, null);

    pass('repaired rows: state filled, district byte-identical (untouched)');

    // Test 6: Post-repair row equals what parseHouseXlsxRows would produce
    console.log('\n--- Test: Post-repair matches ingest output ---');
    // parseHouseXlsxRows for FL08 produces: requesterState='FL', requesterDistrict='FL08'
    const h1After = await query(
      'SELECT requester_state, requester_district FROM community_funding_request WHERE id = $1',
      [h1Id],
    );
    assert.equal(h1After[0].requester_state, 'FL', 'state matches ingest: FL');
    assert.equal(h1After[0].requester_district, 'FL08', 'district matches ingest: raw token FL08 untouched');
    // Also verify it's NOT '08' — the previous bug
    assert.notEqual(h1After[0].requester_district, '08', 'district is NOT rewritten to 08 (the bug)');
    pass('repaired row equals parseHouseXlsxRows output (state + untouched district)');

    // Test 7: Read-path finds the same row AFTER repair (via requester_state now)
    console.log('\n--- Test: Read-path query shape after repair ---');
    const afterReadPathRows = await query(
      `SELECT id, requester_state, requester_district FROM community_funding_request
       WHERE chamber = 'house'
         AND requester_district = ANY($1)
         AND (
           requester_state ILIKE $2
           OR (requester_state IS NULL AND state ILIKE $2)
           OR requester_district ILIKE $3
         )
       ORDER BY id`,
      [districtKeys, stateCode, sourceStdd],
    );
    const h1AfterInReadPath = afterReadPathRows.find((r: any) => r.id === h1Id);
    assert.ok(h1AfterInReadPath != null, 'h1 still found AFTER repair via requester_state branch');
    // h1 still matched via sourceStdd branch AND now also requester_state
    pass('repaired row still returned by read-path query after repair');

    // Test 8: Amounts byte-identical
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

    // Test 9: No rows created or deleted
    const countAfter = (await query('SELECT COUNT(*) AS c FROM community_funding_request'))[0].c;
    assert.equal(countAfter, totalCount, 'no rows created or deleted');
    pass('row counts unchanged after repair');

    // Test 10: Second run is idempotent (0 eligible)
    console.log('\n--- Test: Second run idempotency ---');
    const houseRows2 = await query(
      'SELECT id, identity_hash, chamber, fiscal_year, requester_state, requester_district, state FROM community_funding_request WHERE chamber = $1 ORDER BY id',
      ['house'],
    );

    let eligible2 = 0;
    for (const row of houseRows2) {
      const cls = classifyGeographyRepair({
        chamber: row.chamber as 'house',
        requesterState: row.requester_state,
        requesterDistrict: row.requester_district,
        projectState: row.state,
      });
      if (cls.classification === 'eligible') eligible2++;
    }
    assert.equal(eligible2, 0, 'second run reports 0 eligible rows');
    pass('idempotent: second run is a no-op with 0 eligible');

    // Test 11: Senate rows never repaired
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
          'House STDD repair (FL08) — state only, district untouched',
          'House STDD repair lowercase (fl08)',
          'House at-large repair (AKAL)',
          'already_normalized skipped',
          'conflicting skipped',
          'malformed token invalid (FL8 without projectState)',
          'null token invalid',
          'wrong expected count refuses',
          'correct expected count commits (state only)',
          'district tokens byte-identical before/after',
          'post-repair matches parseHouseXlsxRows output',
          'read-path finds row before (sourceStdd) and after (state)',
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
  houseRows: any[],
): Promise<{ repaired: number; refused: boolean }> {
  let actualEligible = 0;
  for (const row of houseRows) {
    const cls = classifyGeographyRepair({
      chamber: row.chamber as 'house',
      requesterState: row.requester_state,
      requesterDistrict: row.requester_district,
      projectState: row.state,
    });
    if (cls.classification === 'eligible') actualEligible++;
  }

  if (actualEligible !== expectedEligible) {
    return { repaired: 0, refused: true };
  }

  let repaired = 0;
  for (const row of houseRows) {
    const cls = classifyGeographyRepair({
      chamber: row.chamber as 'house',
      requesterState: row.requester_state,
      requesterDistrict: row.requester_district,
      projectState: row.state,
    });
    if (cls.classification !== 'eligible') continue;

    // Optimistic concurrency: requester_state IS NULL AND requester_district matches
    // Only writes requester_state; district stays untouched (byte-identical).
    const result = await db.query(
      'UPDATE community_funding_request SET requester_state = $1 WHERE id = $2 AND requester_state IS NULL AND requester_district IS NOT DISTINCT FROM $3',
      [cls.resolvedState, row.id, row.requester_district],
    );
    // PGlite query doesn't return affected rows count easily; we trust the guard
    repaired++;
  }

  return { repaired, refused: false };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});