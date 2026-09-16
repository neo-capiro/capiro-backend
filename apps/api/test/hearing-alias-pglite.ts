/**
 * Disposable PostgreSQL-engine qualification, without a network database.
 * Run from the repository root with tsx and PGlite installed in the test runtime:
 *   LEGIWATCH_PGLITE_MODULE=@electric-sql/pglite node --import tsx apps/api/test/hearing-alias-pglite.ts
 * LEGIWATCH_PGLITE_MODULE may instead point at a PGlite-compatible adapter that
 * runs this same suite against native PostgreSQL on the dedicated local
 * regression database; every assertion below is engine-agnostic.
 * PGlite runs PostgreSQL compiled to WASM. This does not replace native PostgreSQL
 * migration/deployment qualification or multi-connection lock testing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { reconcileReviewedAliases } from '../src/hearing-discovery/hearing-alias-reconciliation.js';
import type { AliasReview } from '../src/hearing-discovery/hearing-alias-review.js';

const requireTestModule = createRequire(resolve('package.json'));
const { PGlite } = requireTestModule(process.env.LEGIWATCH_PGLITE_MODULE ?? '@electric-sql/pglite');
const migration = readFileSync(
  resolve('apps/api/prisma/migrations/20280915010000_hearing_canonical_alias/migration.sql'),
  'utf8',
);

const schema = `
CREATE TABLE committee_hearing (
  id text PRIMARY KEY, chamber text NOT NULL, congress integer NOT NULL,
  geographic_jurisdiction text, committee_code text, committee_system_code text,
  subcommittee_system_code text, title text NOT NULL, date date NOT NULL, starts_at timestamptz,
  visibility text NOT NULL DEFAULT 'public'
);
CREATE VIEW federal_committee_hearing WITH (security_invoker=true) AS
  SELECT * FROM committee_hearing WHERE geographic_jurisdiction='US' OR geographic_jurisdiction IS NULL;
GRANT SELECT ON federal_committee_hearing TO alias_view_reader;
CREATE TABLE hearing_follow (
  id text PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL,
  hearing_id text NOT NULL REFERENCES committee_hearing(id), UNIQUE(tenant_id,user_id,hearing_id)
);
CREATE TABLE hearing_source_observation (
  id text PRIMARY KEY, hearing_id text NOT NULL REFERENCES committee_hearing(id),
  source_id text NOT NULL, payload jsonb NOT NULL
);
CREATE TABLE committee_hearing_bill (
  id text PRIMARY KEY, hearing_id text NOT NULL REFERENCES committee_hearing(id),
  bill_id text NOT NULL, congress integer NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE(hearing_id,bill_id)
);
CREATE TABLE downstream_soft_reference (id text PRIMARY KEY, "canonicalHearingId" varchar NOT NULL);
`;

function review(number: number): AliasReview {
  return {
    aliasId: `sen-119-${number}`,
    canonicalId: `cm-119-${number}`,
    reason: 'Synthetic test pair shares its exact official Senate event identifier.',
    evidenceUrls: [
      `https://www.congress.gov/event/119th-congress/senate-event/${number}`,
      'https://www.senate.gov/committees/hearings_meetings.htm',
    ],
  };
}

function adapter(db: any) {
  const query = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      query(
        strings.reduce((sql, part, index) => sql + (index ? `$${index}` : '') + part, ''),
        values,
      ),
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => query(sql, values),
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await db.query(sql, values)).affectedRows ?? 0,
    committeeHearing: {
      findUniqueOrThrow: async ({ where }: any) => {
        const rows = await query(
          `SELECT id, chamber, congress,
          geographic_jurisdiction AS "geographicJurisdiction", committee_code AS "committeeCode",
          committee_system_code AS "committeeSystemCode", subcommittee_system_code AS "subcommitteeSystemCode",
          title, date, visibility, starts_at AS "startsAt", canonical_hearing_id AS "canonicalHearingId",
          alias_evidence AS "aliasEvidence", aliased_at AS "aliasedAt"
          FROM committee_hearing WHERE id=$1`,
          [where.id],
        );
        assert.equal(rows.length, 1, 'Fixture hearing must exist');
        return {
          ...rows[0],
          date: new Date(rows[0].date),
          startsAt: rows[0].startsAt ? new Date(rows[0].startsAt) : null,
        };
      },
      count: async ({ where }: any) =>
        Number(
          (
            await query(
              'SELECT count(*) AS count FROM committee_hearing WHERE canonical_hearing_id=$1',
              [where.canonicalHearingId],
            )
          )[0].count,
        ),
      update: async ({ where, data }: any) =>
        (
          await query(
            `UPDATE committee_hearing
        SET canonical_hearing_id=$2, aliased_at=$3, alias_evidence=$4::jsonb WHERE id=$1 RETURNING id`,
            [where.id, data.canonicalHearingId, data.aliasedAt, JSON.stringify(data.aliasEvidence)],
          )
        )[0],
    },
  };
}

async function main() {
  const db = await PGlite.create();
  let checks = 0;
  const transaction = async <T>(work: (tx: any) => Promise<T>): Promise<T> => {
    await db.exec('BEGIN');
    try {
      const result = await work(adapter(db));
      await db.exec('COMMIT');
      return result;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  };
  const reset = async () => {
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await db.exec(schema);
  };
  const pair = async (number: number) => {
    const item = review(number);
    for (const id of [item.aliasId, item.canonicalId]) {
      await db.query(
        `INSERT INTO committee_hearing(id,chamber,congress,geographic_jurisdiction,committee_code,committee_system_code,title,date,starts_at)
        VALUES ($1,'Senate',119,'US','ssju00','ssju00','Synthetic federal oversight qualification','2026-09-15','2026-09-15T13:00:00Z')`,
        [id],
      );
    }
    await db.query('INSERT INTO hearing_follow VALUES ($1,$2,$3,$4)', [
      `follow-${number}`,
      'tenant-one',
      'user-one',
      item.aliasId,
    ]);
    await db.query('INSERT INTO hearing_source_observation VALUES ($1,$2,$3,$4::jsonb)', [
      `observation-${number}`,
      item.aliasId,
      'senate',
      JSON.stringify({ sourceId: item.aliasId, immutable: true }),
    ]);
    await db.query(
      'INSERT INTO committee_hearing_bill (id, hearing_id, bill_id, congress, synced_at) VALUES ($1,$2,$3,119,$4)',
      [`bill-link-${number}`, item.aliasId, 'bill-one', '2026-09-14T10:00:00.123456Z'],
    );
    await db.query('INSERT INTO downstream_soft_reference VALUES ($1,$2)', [
      `soft-${number}`,
      item.aliasId,
    ]);
    return item;
  };
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of [
      'committee_hearing',
      'hearing_follow',
      'hearing_source_observation',
      'committee_hearing_bill',
      'downstream_soft_reference',
    ])
      result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    return JSON.stringify(result);
  };
  const pass = (name: string) => {
    checks++;
    console.log(`PASS ${name}`);
  };
  try {
    console.log((await db.query('SELECT version() AS version')).rows[0].version);
    await db.exec('CREATE ROLE alias_view_reader NOLOGIN');
    await reset();
    await db.exec(migration);
    assert.equal(
      (
        await db.query(
          "SELECT count(*) AS n FROM pg_indexes WHERE indexname='committee_hearing_canonical_hearing_id_idx'",
        )
      ).rows[0].n,
      1,
    );
    assert(
      (
        await db.query("SELECT reloptions FROM pg_class WHERE relname='federal_committee_hearing'")
      ).rows[0].reloptions.includes('security_invoker=true'),
    );
    assert.equal(
      (
        await db.query(
          "SELECT has_table_privilege('alias_view_reader','federal_committee_hearing','SELECT') AS allowed",
        )
      ).rows[0].allowed,
      true,
    );
    pass('additive migration applies to an empty schema');

    await reset();
    await assert.rejects(
      transaction(async () => {
        await db.exec(migration);
        throw new Error('qualification rollback');
      }),
      /qualification rollback/,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*) AS n FROM information_schema.columns WHERE table_name='committee_hearing' AND column_name='canonical_hearing_id'",
        )
      ).rows[0].n,
      0,
    );
    pass('migration DDL rolls back transactionally');

    const populated = await pair(10001);
    const beforeMigration = await snapshot();
    assert.equal(
      (await db.query('SELECT count(*) AS n FROM federal_committee_hearing')).rows[0].n,
      2,
    );
    await db.exec(migration);
    assert.equal((await db.query('SELECT count(*) AS n FROM committee_hearing')).rows[0].n, 2);
    assert.equal(
      (
        await db.query('SELECT canonical_hearing_id FROM committee_hearing WHERE id=$1', [
          populated.aliasId,
        ])
      ).rows[0].canonical_hearing_id,
      null,
    );
    const afterMigration = JSON.parse(await snapshot());
    for (const row of afterMigration.committee_hearing) {
      assert.equal(row.canonical_hearing_id, null);
      assert.equal(row.alias_evidence, null);
      assert.equal(row.aliased_at, null);
      delete row.canonical_hearing_id;
      delete row.alias_evidence;
      delete row.aliased_at;
    }
    assert.deepEqual(afterMigration, JSON.parse(beforeMigration));
    const beforeDryRun = await snapshot();
    const plan = await transaction((tx) =>
      reconcileReviewedAliases(tx, [populated], { apply: false }),
    );
    assert.equal(await snapshot(), beforeDryRun);
    const plans = plan.plans as any[];
    assert.equal(plans[0].references.length, 4);
    pass('populated migration preserves existing rows and dry-run writes zero rows');

    await transaction((tx) =>
      reconcileReviewedAliases(tx, [populated], {
        apply: true,
        expectedPlanHash: String(plan.planHash),
      }),
    );
    assert.equal((await db.query('SELECT count(*) AS n FROM committee_hearing')).rows[0].n, 2);
    assert.equal(
      (
        await db.query(
          'SELECT count(*) AS n FROM committee_hearing WHERE canonical_hearing_id IS NULL',
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await db.query('SELECT count(*) AS n FROM federal_committee_hearing')).rows[0].n,
      1,
    );
    const alias = (
      await db.query('SELECT * FROM committee_hearing WHERE id=$1', [populated.aliasId])
    ).rows[0];
    assert.equal(alias.canonical_hearing_id, populated.canonicalId);
    assert.equal(alias.alias_evidence.planHash, plan.planHash);
    for (const [table, id] of [
      ['hearing_follow', 'follow-10001'],
      ['hearing_source_observation', 'observation-10001'],
      ['committee_hearing_bill', 'bill-link-10001'],
    ]) {
      const rows = (await db.query(`SELECT * FROM ${table}`)).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, id);
      assert.equal(rows[0].hearing_id, populated.canonicalId);
    }
    const movedBill = (
      await db.query(
        `SELECT hearing_id, congress,
          to_char(synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS synced
        FROM committee_hearing_bill WHERE id=$1`,
        ['bill-link-10001'],
      )
    ).rows[0];
    assert.equal(movedBill.hearing_id, populated.canonicalId);
    assert.equal(movedBill.congress, 119);
    assert.equal(movedBill.synced, '2026-09-14T10:00:00.123456');
    assert.equal(
      (await db.query('SELECT "canonicalHearingId" FROM downstream_soft_reference')).rows[0]
        .canonicalHearingId,
      populated.canonicalId,
    );
    assert.deepEqual(
      (await db.query('SELECT payload FROM hearing_source_observation')).rows[0].payload,
      { sourceId: populated.aliasId, immutable: true },
    );
    pass(
      'apply retains both hearings, moves all scalar references atomically, and preserves reference IDs and immutable provenance',
    );

    await assert.rejects(
      db.query('DELETE FROM committee_hearing WHERE id=$1', [populated.canonicalId]),
      (e: any) => e.code === '23503',
    );
    await assert.rejects(
      db.query(
        'UPDATE committee_hearing SET canonical_hearing_id=id, alias_evidence=$1::jsonb, aliased_at=now() WHERE id=$2',
        ['{}', populated.canonicalId],
      ),
      (e: any) => e.code === '23514',
    );
    await assert.rejects(
      db.query(
        'UPDATE committee_hearing SET canonical_hearing_id=$1, alias_evidence=$2::jsonb, aliased_at=now() WHERE id=$3',
        ['missing-hearing', '{}', populated.canonicalId],
      ),
      (e: any) => e.code === '23503',
    );
    await assert.rejects(
      db.query('UPDATE committee_hearing SET alias_evidence=$1::jsonb WHERE id=$2', [
        '{}',
        populated.canonicalId,
      ]),
      (e: any) => e.code === '23514',
    );
    pass(
      'foreign key, delete restriction, self-alias and evidence consistency constraints enforce the migration contract',
    );

    await reset();
    await db.exec(migration);
    const changed = await pair(10002);
    const changedPlan = await transaction((tx) =>
      reconcileReviewedAliases(tx, [changed], { apply: false }),
    );
    await db.query('INSERT INTO downstream_soft_reference VALUES ($1,$2)', [
      'new-reference',
      changed.aliasId,
    ]);
    const beforeRefusal = await snapshot();
    await assert.rejects(
      transaction((tx) =>
        reconcileReviewedAliases(tx, [changed], {
          apply: true,
          expectedPlanHash: String(changedPlan.planHash),
        }),
      ),
      /changed since review/,
    );
    assert.equal(await snapshot(), beforeRefusal);
    pass('reference changes invalidate the reviewed plan and leave every row unchanged');

    await db.query("UPDATE committee_hearing SET visibility='private' WHERE id=$1", [
      changed.aliasId,
    ]);
    const beforeVisibilityRefusal = await snapshot();
    await assert.rejects(
      transaction((tx) => reconcileReviewedAliases(tx, [changed], { apply: false })),
      /visibility conflict/,
    );
    assert.equal(await snapshot(), beforeVisibilityRefusal);
    pass('private-to-public aliasing is refused without changing any row');

    await reset();
    await db.exec(migration);
    const good = await pair(10003),
      conflict = await pair(10004);
    await db.query('INSERT INTO hearing_follow VALUES ($1,$2,$3,$4)', [
      'existing-canonical-follow',
      'tenant-one',
      'user-one',
      conflict.canonicalId,
    ]);
    const batchPlan = await transaction((tx) =>
      reconcileReviewedAliases(tx, [good, conflict], { apply: false }),
    );
    const beforeConflict = await snapshot();
    await assert.rejects(
      transaction((tx) =>
        reconcileReviewedAliases(tx, [good, conflict], {
          apply: true,
          expectedPlanHash: String(batchPlan.planHash),
        }),
      ),
      (e: any) => e.code === '23505',
    );
    assert.equal(await snapshot(), beforeConflict);
    pass(
      'a duplicate follow conflict rolls back the entire batch, including earlier successful pair updates',
    );

    await db.exec(`CREATE ROLE alias_rls_qualification NOLOGIN;
      GRANT USAGE ON SCHEMA public TO alias_rls_qualification;
      GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA public TO alias_rls_qualification;
      ALTER TABLE hearing_follow ENABLE ROW LEVEL SECURITY;
      CREATE POLICY qualified_tenant_only ON hearing_follow USING (tenant_id='different-tenant')`);
    const beforeRls = await snapshot();
    await assert.rejects(
      transaction(async (tx) => {
        await db.exec('SET LOCAL ROLE alias_rls_qualification');
        return reconcileReviewedAliases(tx, [good], { apply: false });
      }),
      (e: any) => e.code === '42501' && /row-level security/i.test(e.message),
    );
    assert.equal(await snapshot(), beforeRls);
    pass(
      'a role subject to tenant RLS fails closed instead of reviewing an incomplete reference set',
    );

    await reset();
    await db.exec(migration);
    const ordinary = await pair(10005),
      protectedReview = await pair(10006);
    await db.exec(`
      CREATE TABLE immutable_hearing_history (id text PRIMARY KEY, hearing_id text NOT NULL);
      CREATE FUNCTION protect_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'IMMUTABLE_TRIGGER_FIRED'; END $$;
      CREATE TRIGGER immutable_history_guard BEFORE UPDATE ON immutable_hearing_history
        FOR EACH ROW EXECUTE FUNCTION protect_immutable_history();
      CREATE TABLE intel_hearing_record_run (id text PRIMARY KEY, event_id text NOT NULL);
      CREATE TABLE intel_hearing_record_brief (id text PRIMARY KEY, event_id text NOT NULL);
      CREATE TABLE intel_hearing_record_job (id text PRIMARY KEY, event_id text NOT NULL, state text NOT NULL);
    `);
    const protectedTables = [
      'immutable_hearing_history',
      'intel_hearing_record_run',
      'intel_hearing_record_brief',
      'intel_hearing_record_job',
    ];
    for (const table of protectedTables) {
      const values = table === 'intel_hearing_record_job' ? "($1,$2,'queued')" : '($1,$2)';
      await db.query(`INSERT INTO ${table} VALUES ${values}`, [
        `${table}-row`,
        protectedReview.aliasId,
      ]);
    }
    const protectedSnapshot = async () =>
      JSON.stringify({
        ordinaryRows: await snapshot(),
        protectedRows: await Promise.all(
          protectedTables.map(
            async (table) => (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
          ),
        ),
      });
    const beforeProtected = await protectedSnapshot();
    const protectedPlan = await transaction((tx) =>
      reconcileReviewedAliases(tx, [ordinary, protectedReview], { apply: false }),
    );
    assert.equal(protectedPlan.readyToApply, false);
    assert.equal(await protectedSnapshot(), beforeProtected);
    const blocked = protectedPlan.blockedOperations as any[];
    assert.deepEqual(blocked.map((row) => row.table).sort(), [...protectedTables].sort());
    assert(
      blocked
        .find((row) => row.table === 'immutable_hearing_history')
        .guards.includes('immutable_history_guard:protect_immutable_history'),
    );
    assert.equal(
      blocked.find((row) => row.table === 'intel_hearing_record_job').column,
      'event_id',
    );
    await assert.rejects(
      transaction((tx) =>
        reconcileReviewedAliases(tx, [ordinary, protectedReview], {
          apply: true,
          expectedPlanHash: String(protectedPlan.planHash),
        }),
      ),
      /Alias reconciliation blocked by immutable references/,
    );
    assert.equal(await protectedSnapshot(), beforeProtected);
    pass(
      'immutable trigger history and run/brief/queued-job event references block dry-run approval and refuse the whole apply batch without updates',
    );

    // ── Bill-link retention semantics (LW8 alias repair, duplicate agenda links) ──
    // committee_hearing_bill is UNIQUE(hearing_id, bill_id): when both sides of
    // a reviewed pair already link the SAME bill (the four verified same-event
    // cm/sen pairs carry up to 24 such overlaps), a blind relocation UPDATE
    // collides with the constraint and aborts the whole batch. The operator
    // must instead RETAIN the alias-side duplicate untouched when the canonical
    // side already links the same billId+congress, and relocate only genuinely
    // non-overlapping links — preserving every row id and synced_at exactly.
    await reset();
    await db.exec(migration);
    const billPair = await pair(10007);
    // The pair fixture already links bill-one on the alias side; that row IS the
    // duplicate. Add only a non-overlapping alias-side bill-two and the
    // canonical side's own bill-one link (different id + synced_at).
    await db.query(
      'INSERT INTO committee_hearing_bill (id, hearing_id, bill_id, congress, synced_at) VALUES ($1,$2,$3,$4,$5)',
      ['bill-alias-only', billPair.aliasId, 'bill-two', 119, '2026-09-14T11:00:00.654322Z'],
    );
    await db.query(
      'INSERT INTO committee_hearing_bill (id, hearing_id, bill_id, congress, synced_at) VALUES ($1,$2,$3,$4,$5)',
      ['bill-canonical-one', billPair.canonicalId, 'bill-one', 119, '2026-09-14T12:00:00.000001Z'],
    );
    const billPlan = await transaction((tx) =>
      reconcileReviewedAliases(tx, [billPair], { apply: false }),
    );
    // The plan must inventory exact bill rows so content changes with stable
    // counts still invalidate the reviewed hash.
    const billPlanLink = ((billPlan.plans as any[])[0].references as any[]).find(
      (r) => r.tableName === 'committee_hearing_bill',
    );
    assert.ok(billPlanLink, 'Bill links must appear in the plan reference inventory');
    assert.ok(billPlanLink.rows, 'Bill-link inventory must include exact rows, not just counts');
    const dupRow = billPlanLink.rows.find((r: { id: string }) => r.id === 'bill-link-10007');
    assert.ok(dupRow && dupRow.rowText && dupRow.rowText.includes('bill-one'));
    // Dry run must not touch any row.
    assert.equal(
      (
        await db.query('SELECT count(*) AS n FROM committee_hearing_bill WHERE hearing_id=$1', [
          billPair.aliasId,
        ])
      ).rows[0].n,
      2,
    );
    pass('bill-link plan inventories exact duplicate rows for the reviewed hash');

    await transaction((tx) =>
      reconcileReviewedAliases(tx, [billPair], {
        apply: true,
        expectedPlanHash: String(billPlan.planHash),
      }),
    );
    // Duplicate link retained on the alias side, byte-for-byte. Assert by id,
    // never by result order.
    const rowsById = new Map<string, any>(
      (
        await db.query(
          `SELECT id, hearing_id, bill_id, congress,
            to_char(synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS synced
          FROM committee_hearing_bill ORDER BY id`,
        )
      ).rows.map((row: any) => [row.id as string, row]),
    );
    assert.equal(rowsById.size, 3);
    // The pair's alias-side duplicate of canonical bill-one is untouched.
    const retainedDup = rowsById.get('bill-link-10007')!;
    assert.equal(retainedDup.hearing_id, billPair.aliasId);
    assert.equal(retainedDup.bill_id, 'bill-one');
    assert.equal(retainedDup.congress, 119);
    assert.equal(retainedDup.synced, '2026-09-14T10:00:00.123456'); // exact original timestamp
    // The canonical side's own bill-one link is untouched too.
    const canonicalOne = rowsById.get('bill-canonical-one')!;
    assert.equal(canonicalOne.hearing_id, billPair.canonicalId);
    assert.equal(canonicalOne.bill_id, 'bill-one');
    assert.equal(canonicalOne.synced, '2026-09-14T12:00:00.000001');
    // The non-overlapping alias-side bill-two moved normally.
    const movedOnly = rowsById.get('bill-alias-only')!;
    assert.equal(movedOnly.hearing_id, billPair.canonicalId);
    assert.equal(movedOnly.bill_id, 'bill-two');
    assert.equal(movedOnly.synced, '2026-09-14T11:00:00.654322');
    // Stored alias evidence must distinguish retained vs moved links.
    const billAlias = (
      await db.query('SELECT alias_evidence FROM committee_hearing WHERE id=$1', [billPair.aliasId])
    ).rows[0].alias_evidence;
    const billEvidence = billAlias.references.find(
      (r: { tableName: string }) => r.tableName === 'committee_hearing_bill',
    );
    assert.ok(billEvidence, 'aliasEvidence must carry the bill-link disposition');
    assert.deepEqual(billEvidence.retained, ['bill-link-10007']);
    assert.deepEqual(billEvidence.moved, ['bill-alias-only']);
    assert.equal(billEvidence.retained.length + billEvidence.moved.length, 2);
    pass(
      'apply retains the duplicate alias-side bill link byte-for-byte, moves only the non-overlap, and records the split disposition',
    );

    // Stable-count content change must invalidate the hash (synced_at nudge).
    await reset();
    await db.exec(migration);
    const hashPair = await pair(10008);
    // The pair's own alias-side bill-one row is the duplicate; add only the
    // canonical-side equivalent.
    await db.query(
      'INSERT INTO committee_hearing_bill (id, hearing_id, bill_id, congress, synced_at) VALUES ($1,$2,$3,$4,$5)',
      ['bill-hash-canonical', hashPair.canonicalId, 'bill-one', 119, '2026-09-14T12:00:00.000001Z'],
    );
    const stalePlan = await transaction((tx) =>
      reconcileReviewedAliases(tx, [hashPair], { apply: false }),
    );
    await db.query(
      "UPDATE committee_hearing_bill SET synced_at='2026-09-14T11:00:00.654999Z' WHERE id='bill-link-10008'",
    );
    const beforeHashRefusal = await snapshot();
    await assert.rejects(
      transaction((tx) =>
        reconcileReviewedAliases(tx, [hashPair], {
          apply: true,
          expectedPlanHash: String(stalePlan.planHash),
        }),
      ),
      /changed since review/,
    );
    assert.equal(await snapshot(), beforeHashRefusal);
    pass('a stable-count bill-row content change invalidates the reviewed plan hash');

    // Conflicting Congress on the same billId must abort the whole batch.
    await reset();
    await db.exec(migration);
    const conflictPair = await pair(10009);
    // Conflicting Congress on the SAME billId: the pair's alias-side bill-one
    // row (congress 119) vs a canonical-side bill-one row with congress 118.
    await db.query(
      'INSERT INTO committee_hearing_bill (id, hearing_id, bill_id, congress, synced_at) VALUES ($1,$2,$3,$4,$5)',
      [
        'bill-conflict-canonical',
        conflictPair.canonicalId,
        'bill-one',
        118,
        '2026-09-14T12:00:00.000001Z',
      ],
    );
    const beforeCongressRefusal = await snapshot();
    await assert.rejects(
      transaction((tx) => reconcileReviewedAliases(tx, [conflictPair], { apply: false })),
      /conflicting Congress/,
    );
    assert.equal(await snapshot(), beforeCongressRefusal);
    pass('a duplicate bill link with a conflicting Congress is refused before any update');

    // An unrelated mid-batch uniqueness collision still rolls back everything,
    // including already-applied pairs and retained bill links.
    await reset();
    await db.exec(migration);
    const earlyPair = await pair(10010),
      latePair = await pair(10011);
    // earlyPair: the pair fixtures already link bill-one on BOTH sides
    // (alias: bill-link-10010, canonical: inserted below) with the same
    // congress → that link is RETAINED, and the late pair's follow collision
    // must still roll the whole batch back, retention included.
    await db.query(
      'INSERT INTO committee_hearing_bill (id, hearing_id, bill_id, congress, synced_at) VALUES ($1,$2,$3,$4,$5)',
      [
        'bill-early-canonical',
        earlyPair.canonicalId,
        'bill-one',
        119,
        '2026-09-14T12:00:00.000001Z',
      ],
    );
    // latePair: an existing canonical-side hearing_follow for the SAME
    // (tenant,user) collides with the moved alias-side follow (23505) — an
    // unrelated-table collision after retention has run for the early pair.
    await db.query('INSERT INTO hearing_follow VALUES ($1,$2,$3,$4)', [
      'existing-late-canonical-follow',
      'tenant-one',
      'user-one',
      latePair.canonicalId,
    ]);
    const latePlan = await transaction((tx) =>
      reconcileReviewedAliases(tx, [earlyPair, latePair], { apply: false }),
    );
    const beforeRollback = await snapshot();
    await assert.rejects(
      transaction((tx) =>
        reconcileReviewedAliases(tx, [earlyPair, latePair], {
          apply: true,
          expectedPlanHash: String(latePlan.planHash),
        }),
      ),
      (e: any) => e.code === '23505',
    );
    assert.equal(await snapshot(), beforeRollback);
    pass(
      'a mid-batch follow collision rolls back the entire batch, including a prior pair’s retained bill links',
    );

    console.log(
      JSON.stringify({
        checks,
        result: 'passed',
        nativePostgresDeploymentQualification: 'still required',
        multiConnectionLockQualification: 'not covered by single-connection PGlite',
      }),
    );
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
