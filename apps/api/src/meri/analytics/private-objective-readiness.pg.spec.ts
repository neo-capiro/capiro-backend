import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  emptyStrategyIntake,
  STRATEGY_INTAKE_TYPE_LABELS,
  STRATEGY_INTAKE_TYPES,
  type StrategyIntakeDraft,
} from '@capiro/shared/strategy-intake';
import {
  objectiveReadiness,
  type ObjectiveFields,
} from '../../clients/objectives/objective-rules.js';

/**
 * meri_private.client_objectives readiness through the real migrations on
 * PGlite, read as the actual private reader role under the tenant RLS policies.
 * Snapshots carry `readiness` computed by the service's objectiveReadiness,
 * exactly as ClientObjectivesService.recordRevision stores it.
 */
const migration = (name: string) =>
  readFileSync(resolve(process.cwd(), `prisma/migrations/${name}/migration.sql`), 'utf8');
const BEFORE = [
  '20281011010000_client_objectives',
  '20281102200000_client_objective_intake_ready',
  '20281024170000_private_sql_client_projections',
];
const AFTER = [
  '20281102201000_private_objective_revision_readiness_grant',
  '20281102202000_private_objective_intake_readiness_view',
  '20281102203000_private_objective_intake_readiness_catalog',
  '20281102210000_private_objective_intake_answers_view',
  '20281102211000_private_objective_intake_answers_catalog',
];

const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantA = id(1),
  tenantB = id(2),
  actor = id(11),
  clientA = id(21),
  clientB = id(22);
const intakeReady = id(31),
  intakeDraft = id(32),
  legacyReady = id(33),
  staleIntake = id(34),
  foreignIntake = id(35);

const legacyBlank: ObjectiveFields = {
  outcome: '',
  governmentProblem: '',
  askType: null,
  minimumWin: '',
  limits: '',
};
const answers = (overrides: Partial<StrategyIntakeDraft> = {}): StrategyIntakeDraft => ({
  ...emptyStrategyIntake('user_synthetic_owner'),
  type: 'appropriations',
  goal: 'Synthetic goal',
  ...overrides,
});
/** The stored snapshot fields this view depends on, built with the service rule. */
function snapshot(fields: ObjectiveFields, status: string, version: number) {
  return { ...fields, status, version, readiness: objectiveReadiness(fields) };
}

describe('meri_private.client_objectives readiness follows the service rule (PGlite)', () => {
  let db: PGlite;
  let columnsBefore: Array<{ attname: string; type: string }>;
  const columns = async () =>
    (
      await db.query<{ attname: string; type: string }>(
        `SELECT attname, format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = 'meri_private.client_objectives'::regclass AND attnum > 0 ORDER BY attnum`,
      )
    ).rows;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;
      CREATE TABLE tenants(id uuid PRIMARY KEY, status text NOT NULL);
      CREATE TABLE tenant_memberships(tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, status text NOT NULL);
      CREATE TABLE clients(id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), status text NOT NULL,
        memory_wall boolean NOT NULL DEFAULT false, UNIQUE(tenant_id, id));
      CREATE TABLE client_memory_access(tenant_id uuid NOT NULL, client_id uuid NOT NULL, user_id uuid NOT NULL);
      CREATE TABLE client_activity(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, client_id uuid NOT NULL, kind text,
        occurred_at timestamptz, title text, body text, actor_user_id uuid, person_id uuid, source_type text, source_id text,
        pinned boolean, due_at timestamptz, settled_at timestamptz, metadata_jsonb jsonb, created_by_user_id uuid,
        created_at timestamptz, updated_at timestamptz);
      ALTER TABLE tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenants_isolation ON tenants USING (rls_bypass() OR id = current_tenant_id());
    `);
    for (const table of [
      'tenant_memberships',
      'clients',
      'client_memory_access',
      'client_activity',
    ])
      await db.exec(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY ${table}_isolation ON ${table} USING (rls_bypass() OR tenant_id = current_tenant_id());`);
    for (const name of BEFORE) await db.exec(migration(name));
    columnsBefore = await columns();
    for (const name of AFTER) await db.exec(migration(name));

    await db.query(`INSERT INTO tenants VALUES ($1,'active'),($2,'active')`, [tenantA, tenantB]);
    await db.query(
      `INSERT INTO tenant_memberships VALUES ($1,$2,'standard_user','active'),($3,$2,'standard_user','active')`,
      [tenantA, actor, tenantB],
    );
    await db.query(
      `INSERT INTO clients(id,tenant_id,status) VALUES ($1,$2,'active'),($3,$4,'active')`,
      [clientA, tenantA, clientB, tenantB],
    );
    const legacy: ObjectiveFields = {
      outcome: 'Extend authority',
      governmentProblem: 'Authority expires',
      askType: 'meri_propose',
      minimumWin: 'One year',
      limits: '',
    };
    const rows: Array<
      [string, string, string, ObjectiveFields, string, number, Array<[number, object]>]
    > = [
      [
        intakeReady,
        tenantA,
        clientA,
        legacyBlank,
        'ready',
        2,
        [
          [1, snapshot({ ...legacyBlank, strategyIntake: answers() }, 'draft', 1)],
          [
            2,
            snapshot(
              { ...legacyBlank, strategyIntake: answers({ targetDate: '2027-02-28' }) },
              'ready',
              2,
            ),
          ],
        ],
      ],
      [
        intakeDraft,
        tenantA,
        clientA,
        legacyBlank,
        'draft',
        1,
        [[1, snapshot({ ...legacyBlank, strategyIntake: answers({ goal: ' \n ' }) }, 'draft', 1)]],
      ],
      [legacyReady, tenantA, clientA, legacy, 'ready', 1, [[1, snapshot(legacy, 'ready', 1)]]],
      // The service hydrates only the exact current revision; an older intake never applies.
      [
        staleIntake,
        tenantA,
        clientA,
        legacyBlank,
        'draft',
        3,
        [[2, snapshot({ ...legacyBlank, strategyIntake: answers() }, 'draft', 2)]],
      ],
      [
        foreignIntake,
        tenantB,
        clientB,
        legacyBlank,
        'ready',
        1,
        [[1, snapshot({ ...legacyBlank, strategyIntake: answers() }, 'ready', 1)]],
      ],
    ];
    for (const [objective, tenant, client, f, status, version, revisions] of rows) {
      await db.query(
        `INSERT INTO client_objectives(id,tenant_id,client_id,client_request_id,create_request_hash,created_by_user_id,
          outcome,government_problem,ask_type,minimum_win,status,version)
         VALUES($1,$2,$3,gen_random_uuid(),repeat('a',64),$4,$5,$6,$7,$8,$9,$10)`,
        [
          objective,
          tenant,
          client,
          actor,
          f.outcome,
          f.governmentProblem,
          f.askType,
          f.minimumWin,
          status,
          version,
        ],
      );
      for (const [revisionVersion, snap] of revisions)
        await db.query(
          `INSERT INTO client_objective_revisions(tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
           VALUES($1,$2,$3,$4,'edit',$5,$6)`,
          [tenant, client, objective, revisionVersion, actor, JSON.stringify(snap)],
        );
    }
  }, 120000);
  afterAll(async () => {
    await db?.close();
  });
  afterEach(async () => {
    await db.exec('RESET ROLE');
  });

  async function asReader(sql: string) {
    await db.exec('SET ROLE capiro_private_query_ro');
    for (const [key, value] of [
      ['app.current_tenant', tenantA],
      ['app.current_user', actor],
      ['app.meri_query_scope', 'general'],
      ['app.meri_query_client', ''],
      ['app.bypass_rls', 'off'],
    ])
      await db.query('SELECT set_config($1,$2,false)', [key, value]);
    return db.query<Record<string, unknown>>(sql);
  }

  test('an intake Objective reads as ready out of 3; legacy, incomplete and stale rows keep their rule', async () => {
    const result =
      await asReader(`SELECT id, status, readiness_basis, readiness_completed_fields, readiness_required_fields,
      readiness_is_ready, readiness_objective_type, readiness_goal, readiness_owner, readiness_outcome
      FROM meri_private.client_objectives ORDER BY id`);
    expect(result.rows).toEqual([
      {
        id: intakeReady,
        status: 'ready',
        readiness_basis: 'strategy_intake',
        readiness_completed_fields: 3,
        readiness_required_fields: 3,
        readiness_is_ready: true,
        readiness_objective_type: true,
        readiness_goal: true,
        readiness_owner: true,
        readiness_outcome: false,
      },
      {
        id: intakeDraft,
        status: 'draft',
        readiness_basis: 'strategy_intake',
        readiness_completed_fields: 2,
        readiness_required_fields: 3,
        readiness_is_ready: false,
        readiness_objective_type: true,
        readiness_goal: false,
        readiness_owner: true,
        readiness_outcome: false,
      },
      {
        id: legacyReady,
        status: 'ready',
        readiness_basis: 'objective_fields',
        readiness_completed_fields: 4,
        readiness_required_fields: 4,
        readiness_is_ready: true,
        readiness_objective_type: null,
        readiness_goal: null,
        readiness_owner: null,
        readiness_outcome: true,
      },
      {
        id: staleIntake,
        status: 'draft',
        readiness_basis: 'objective_fields',
        readiness_completed_fields: 0,
        readiness_required_fields: 4,
        readiness_is_ready: false,
        readiness_objective_type: null,
        readiness_goal: null,
        readiness_owner: null,
        readiness_outcome: false,
      },
    ]);
  });

  test('an intake Objective is published with its saved intake answers; legacy and stale rows have none', async () => {
    const result = await asReader(`SELECT id, readiness_basis, intake_type, intake_goal,
      intake_target_date::text AS intake_target_date, outcome
      FROM meri_private.client_objectives ORDER BY id`);
    const none = { intake_type: null, intake_goal: null, intake_target_date: null };
    expect(result.rows).toEqual([
      {
        id: intakeReady,
        readiness_basis: 'strategy_intake',
        intake_type: 'appropriations',
        intake_goal: 'Synthetic goal',
        intake_target_date: '2027-02-28',
        outcome: '',
      },
      {
        id: intakeDraft,
        readiness_basis: 'strategy_intake',
        intake_type: 'appropriations',
        intake_goal: answers({ goal: ' \n ' }).goal,
        intake_target_date: null,
        outcome: '',
      },
      {
        id: legacyReady,
        readiness_basis: 'objective_fields',
        ...none,
        outcome: 'Extend authority',
      },
      { id: staleIntake, readiness_basis: 'objective_fields', ...none, outcome: '' },
    ]);
  });

  test('a saved target date PostgreSQL cannot represent reads as null instead of failing the view', async () => {
    // Year 0000 was accepted by earlier writers; 2026-02-30 is shape-valid only.
    const bad: Array<[string, string]> = [
      [id(36), '0000-01-01'],
      [id(37), '0000-02-29'],
      [id(38), '2026-02-30'],
    ];
    await db.exec('BEGIN');
    try {
      for (const [objective, targetDate] of bad) {
        await db.query(
          `INSERT INTO client_objectives(id,tenant_id,client_id,client_request_id,create_request_hash,created_by_user_id,status)
           VALUES($1,$2,$3,gen_random_uuid(),repeat('a',64),$4,'ready')`,
          [objective, tenantA, clientA, actor],
        );
        await db.query(
          `INSERT INTO client_objective_revisions(tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
           VALUES($1,$2,$3,1,'edit',$4,$5)`,
          [
            tenantA,
            clientA,
            objective,
            actor,
            // The current parser refuses these; store them as an earlier writer did.
            JSON.stringify(
              (({ strategyIntake, ...saved }) => ({
                ...saved,
                strategyIntake: { ...strategyIntake, targetDate },
              }))(snapshot({ ...legacyBlank, strategyIntake: answers() }, 'ready', 1)),
            ),
          ],
        );
      }
      const result = await asReader(
        `SELECT id, intake_goal, intake_target_date::text AS intake_target_date
         FROM meri_private.client_objectives WHERE id IN ('${id(36)}','${id(37)}','${id(38)}','${intakeReady}') ORDER BY id`,
      );
      expect(result.rows).toEqual([
        { id: intakeReady, intake_goal: 'Synthetic goal', intake_target_date: '2027-02-28' },
        ...bad.map(([objective]) => ({
          id: objective,
          intake_goal: 'Synthetic goal',
          intake_target_date: null,
        })),
      ]);
      expect((await db.query('SELECT * FROM meri_private.client_objectives')).rows).toHaveLength(7);
    } finally {
      await db.exec('ROLLBACK');
    }
  });

  test('the reader still cannot read revisions or Objectives directly', async () => {
    await expect(
      asReader('SELECT snapshot FROM public.client_objective_revisions'),
    ).rejects.toMatchObject({ code: '42501' });
    await db.exec('RESET ROLE');
    await expect(asReader('SELECT id FROM public.client_objectives')).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('existing columns, owner, options and grants are unchanged; readiness and intake columns are appended', async () => {
    const after = await columns();
    expect(after.slice(0, columnsBefore.length)).toEqual(columnsBefore);
    expect(after.slice(columnsBefore.length)).toEqual([
      { attname: 'readiness_basis', type: 'text' },
      { attname: 'readiness_objective_type', type: 'boolean' },
      { attname: 'readiness_goal', type: 'boolean' },
      { attname: 'readiness_owner', type: 'boolean' },
      { attname: 'intake_type', type: 'text' },
      { attname: 'intake_goal', type: 'text' },
      { attname: 'intake_target_date', type: 'date' },
    ]);
    const view = await db.query<{ owner: string; reloptions: string[]; acl: string[] }>(
      `SELECT pg_get_userbyid(relowner) AS owner, reloptions, relacl::text[] AS acl
       FROM pg_class WHERE oid = 'meri_private.client_objectives'::regclass`,
    );
    expect(view.rows[0]!.owner).toBe('capiro_private_projection_owner');
    expect(view.rows[0]!.reloptions).toEqual(['security_barrier=true', 'security_invoker=false']);
    expect([...view.rows[0]!.acl].sort()).toEqual([
      'capiro_private_projection_owner=arwdDxtm/capiro_private_projection_owner',
      'capiro_private_query_ro=r/capiro_private_projection_owner',
    ]);
  });

  test('the view owner gains exactly the five revision columns pinned by private-sql-admission.ts', async () => {
    const granted = await db.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'public.client_objective_revisions'::regclass AND attnum > 0
       AND NOT attisdropped AND has_column_privilege('capiro_private_projection_owner', attrelid, attnum, 'SELECT')
       ORDER BY attname`,
    );
    expect(granted.rows.map((row) => row.attname)).toEqual([
      'client_id',
      'objective_id',
      'snapshot',
      'tenant_id',
      'version',
    ]);
    const admission = readFileSync(
      resolve(process.cwd(), 'src/meri/analytics/private-sql-admission.ts'),
      'utf8',
    );
    expect(admission).toContain(
      "('client_objective_revisions', ARRAY['client_id','objective_id','snapshot','tenant_id','version']::text[])",
    );
    expect(admission).toContain('(SELECT count(*) FROM sources) = 24');
    const table = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.client_objective_revisions'::regclass`,
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  test('catalog comments are JSON and no longer state a fixed four-field rule', async () => {
    const comments = await db.query<{ attname: string; comment: string }>(
      `SELECT attname, col_description(attrelid, attnum) AS comment FROM pg_attribute
       WHERE attrelid = 'meri_private.client_objectives'::regclass AND attname LIKE 'readiness%' ORDER BY attnum`,
    );
    expect(comments.rows).toHaveLength(11);
    for (const row of comments.rows) expect(() => JSON.parse(row.comment)).not.toThrow();
    const byName = Object.fromEntries(
      comments.rows.map((row) => [row.attname, JSON.parse(row.comment)]),
    );
    expect(byName.readiness_basis.enum).toEqual(['strategy_intake', 'objective_fields']);
    expect(byName.readiness_required_fields.description).toMatch(
      /^Three for strategy_intake .* or four for objective_fields/,
    );
    for (const migrationName of AFTER) expect(migration(migrationName)).not.toContain('\r');
  });

  test('catalog describes intake Objectives by their answers in the shared intake vocabulary', async () => {
    const view = await db.query<{ comment: string }>(
      `SELECT obj_description('meri_private.client_objectives'::regclass, 'pg_class') AS comment`,
    );
    const limitations = (JSON.parse(view.rows[0]!.comment).limitations as string[]).join(' ');
    expect(limitations).toContain('described by intake_type, intake_goal and intake_target_date');
    expect(limitations).toContain('never report the legacy fields as empty, missing or skipped');
    const comments = await db.query<{ attname: string; comment: string }>(
      `SELECT attname, col_description(attrelid, attnum) AS comment FROM pg_attribute
       WHERE attrelid = 'meri_private.client_objectives'::regclass
         AND attname IN ('intake_type', 'intake_goal', 'intake_target_date', 'outcome', 'ask_type')`,
    );
    const byName = Object.fromEntries(
      comments.rows.map((row) => [row.attname, JSON.parse(row.comment)]),
    );
    expect(byName.intake_type.enum).toEqual([...STRATEGY_INTAKE_TYPES]);
    for (const type of STRATEGY_INTAKE_TYPES)
      expect(byName.intake_type.description).toContain(
        `${type} = ${STRATEGY_INTAKE_TYPE_LABELS[type]}`,
      );
    expect(migration('20281102210000_private_objective_intake_answers_view')).toContain(
      `IN (${STRATEGY_INTAKE_TYPES.map((type) => `'${type}'`).join(', ')})`,
    );
    expect(byName.intake_goal.description).toContain(
      'main description of a strategy_intake Objective',
    );
    expect(byName.intake_target_date).toBeDefined();
    expect(byName.outcome.description).toContain(
      'blank by design when readiness_basis is strategy_intake',
    );
    expect(byName.ask_type.description).toContain('use intake_type instead');
  });
});
