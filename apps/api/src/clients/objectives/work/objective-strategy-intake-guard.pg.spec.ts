import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { objectiveIntentFromSnapshot, objectiveStrategyDraftInput } from '../../../../../../packages/shared/src/strategy-intake';

const migrations = resolve(process.cwd(), 'prisma/migrations');
const intakeMigration = readFileSync(resolve(migrations, '20281017010000_client_objective_strategy_intake/migration.sql'), 'utf8');
const guardMigration = readFileSync(
  resolve(migrations, '20281102215000_objective_strategy_intake_guard_shared_answers/migration.sql'), 'utf8');
/** The applied guard exactly as the original migration created it. */
const originalGuard = intakeMigration.slice(
  intakeMigration.indexOf('CREATE FUNCTION public.objective_strategy_intake_insert_guard()'),
  intakeMigration.indexOf('END $$;', intakeMigration.indexOf('CREATE FUNCTION public.objective_strategy_intake_insert_guard()')) + 'END $$;'.length);

const tenant = '11111111-1111-4111-8111-111111111111', client = '22222222-2222-4222-8222-222222222222';
const objective = '33333333-3333-4333-8333-333333333333', user = '44444444-4444-4444-8444-444444444444';
const membership = '55555555-5555-4555-8555-555555555555', control = '66666666-6666-4666-8666-666666666666';
const clerk = 'user_owner';
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const hash = (c: string) => c.repeat(64);

/** Only the columns the guard reads; constraints and FKs belong to the applied migrations. */
const schema = `
CREATE TABLE client_objective_work_consents (id uuid, tenant_id uuid, client_id uuid, objective_id uuid, work_action text,
  control_id uuid, command_request_id uuid, command_receipt_id uuid, consenting_actor_user_id uuid, consenting_membership_id uuid,
  canonical_plan_id uuid, canonical_epoch int, canonical_strategy_id uuid, canonical_project_id uuid, canonical_binding_version int,
  root_intent_id uuid, source_revision_id uuid, source_objective_version int, source_snapshot_hash text, root_actor_user_id uuid,
  payload_digest text, previous_consent_id uuid, confirmed_at timestamptz, expires_at timestamptz);
CREATE TABLE client_objective_work_command_receipts (id uuid, tenant_id uuid, client_id uuid, objective_id uuid, work_action text,
  control_id uuid, command_kind text, outcome text, created_consent_id uuid, result_consent_id uuid, request_id uuid,
  control_version_after int, actor_user_id uuid, actor_membership_id uuid, canonical_plan_id uuid, canonical_epoch int,
  canonical_strategy_id uuid, canonical_project_id uuid, canonical_binding_version int, root_intent_id uuid, source_revision_id uuid,
  source_objective_version int, source_snapshot_hash text, root_actor_user_id uuid, payload_digest text, target_consent_id uuid,
  command_revision_id uuid, command_objective_version int, committed_at timestamptz, command jsonb);
CREATE TABLE users (id uuid, clerk_user_id text);
CREATE TABLE tenant_memberships (id uuid, user_id uuid, tenant_id uuid, status text, role text);
CREATE TABLE client_objective_revisions (id uuid, tenant_id uuid, client_id uuid, objective_id uuid, version int, operation text, snapshot jsonb);
CREATE TABLE sp_draft_job (id uuid, tenant_id uuid, client_id uuid, owner_user_id text, request_key text, input jsonb, status text,
  attempt int, claimed_by text, claimed_at timestamptz, strategy_id uuid, deadline_at timestamp);
CREATE TABLE client_objective_strategy_intakes (id uuid, tenant_id uuid, client_id uuid, objective_id uuid, work_action text,
  control_id uuid, consent_id uuid, command_receipt_id uuid, command_request_id uuid, control_version int, actor_user_id uuid,
  actor_membership_id uuid, original_clerk_user_id text, canonical_plan_id uuid, canonical_epoch int, canonical_strategy_id uuid,
  canonical_project_id uuid, canonical_binding_version int, root_intent_id uuid, source_revision_id uuid, source_objective_version int,
  source_snapshot_hash text, root_actor_user_id uuid, selected_type text, generation_request_id uuid, wrapper jsonb, wrapper_sha256 text,
  typed_request jsonb, request_fingerprint text, job_request_key text, generation_job_id uuid, original_deadline_at timestamptz,
  reserved_at timestamptz DEFAULT clock_timestamp());
INSERT INTO users VALUES ('${user}','${clerk}');
INSERT INTO tenant_memberships VALUES ('${membership}','${user}','${tenant}','active','standard_user');
`;
const trigger = `CREATE CONSTRAINT TRIGGER objective_strategy_intakes_insert_guard AFTER INSERT ON public.client_objective_strategy_intakes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.objective_strategy_intake_insert_guard();`;

const intake = { schemaVersion: 1, type: 'appropriations', goal: 'Fund the program in FY27', ownerUserId: clerk,
  targetDate: '2027-03-01', meriContext: 'Prior year language' };
const shapes = {
  legacy: { outcome: 'Fund the program in FY27', governmentProblem: 'Gap', askType: 'funding', minimumWin: 'Report language', limits: '' },
  intake: { outcome: '', governmentProblem: '', askType: null, minimumWin: '', limits: '', strategyIntake: intake },
};

/** One selected-Strategy reservation, the job DTO built by the application's own projection. */
async function reserve(db: PGlite, snapshotFields: Record<string, unknown>,
  { type = 'appropriations', dto }: { type?: string; dto?: unknown } = {}) {
  const revision = uuid(), consent = uuid(), receipt = uuid(), request = uuid(), job = uuid(), id = uuid(), generation = uuid();
  const plan = uuid(), strategy = uuid(), project = uuid(), root = uuid();
  const snapshot = { id: objective, clientId: client, version: 3, status: 'ready', deletedAt: null, ownerUserId: user, ...snapshotFields };
  const command = { schemaVersion: 1, requestId: request, command: 'retry' };
  const source = { clientId: client, objectiveId: objective, objectiveVersion: 3, objectiveRevisionId: revision };
  const typed = { requestId: generation, clientId: client, objective: { objectiveId: objective, objectiveVersion: 3 }, type };
  const envelope = { request: typed, fingerprint: hash('f'), receipt: { schemaVersion: 1, requestId: generation, source,
    context: { reobservedAt: null, state: 'pending', packetId: null, compiledAt: null, sourceDigest: null, coverageDigest: null,
      inputDigest: null, issues: [] }, result: null, failure: null } };
  const marker = { schemaVersion: 1, intakeId: id, consentId: consent, commandReceiptId: receipt, wrapperSha256: hash('w') };
  const input = { bearer: null, objectiveGeneration: envelope, objectiveCanonicalReservation: marker,
    dto: dto ?? objectiveStrategyDraftInput(client, type as 'appropriations', objectiveIntentFromSnapshot(snapshot)) };
  const lineage = [plan, 1, strategy, project, 1, root, revision, 3, hash('s'), user];
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO client_objective_revisions VALUES ($1,$2,$3,$4,3,'confirm_ready',$5)`,
      [revision, tenant, client, objective, JSON.stringify(snapshot)]);
    await db.query(`INSERT INTO client_objective_work_consents VALUES ($1,$2,$3,$4,'objective.strategy.draft',$5,$6,$7,$8,$9,
      $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NULL,clock_timestamp()-interval '1 second',clock_timestamp()+interval '30 minutes')`,
      [consent, tenant, client, objective, control, request, receipt, user, membership, ...lineage, hash('p')]);
    await db.query(`INSERT INTO client_objective_work_command_receipts VALUES ($1,$2,$3,$4,'objective.strategy.draft',$5,'retry',
      'reconsent_recorded',$6,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NULL,$16,$17,clock_timestamp()-interval '1 second',$21)`,
      [receipt, tenant, client, objective, control, consent, request, user, membership, ...lineage, hash('p'), JSON.stringify(command)]);
    await db.query(`INSERT INTO sp_draft_job VALUES ($1,$2,$3,$4,$5,$6,'queued',1,NULL,NULL,NULL,
      (clock_timestamp()+interval '20 minutes') AT TIME ZONE 'UTC')`,
      [job, tenant, client, clerk, `objective-v1:${hash('k')}`, JSON.stringify(input)]);
    await db.query(`INSERT INTO client_objective_strategy_intakes (id,tenant_id,client_id,objective_id,work_action,control_id,consent_id,
      command_receipt_id,command_request_id,control_version,actor_user_id,actor_membership_id,original_clerk_user_id,canonical_plan_id,
      canonical_epoch,canonical_strategy_id,canonical_project_id,canonical_binding_version,root_intent_id,source_revision_id,
      source_objective_version,source_snapshot_hash,root_actor_user_id,selected_type,generation_request_id,wrapper,wrapper_sha256,
      typed_request,request_fingerprint,job_request_key,generation_job_id,original_deadline_at)
      SELECT $1,$2,$3,$4,'objective.strategy.draft',$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
        jsonb_build_object('schemaVersion',2,'command',$24::jsonb,'selection',jsonb_build_object('type',$22::text,'generationRequestId',$23::uuid)),
        $25,$26,$27,$28,$29,j.deadline_at AT TIME ZONE 'UTC' FROM sp_draft_job j WHERE j.id=$29`,
      [id, tenant, client, objective, control, consent, receipt, request, user, membership, clerk, ...lineage, type, generation,
        JSON.stringify(command), hash('w'), JSON.stringify(typed), hash('f'), `objective-v1:${hash('k')}`, job]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

describe('selected Strategy intake guard on local ephemeral PostgreSQL (PGlite)', () => {
  const opened: PGlite[] = [];
  async function database(applied: 'original' | 'current') {
    const db = new PGlite();
    opened.push(db);
    await db.exec(schema);
    await db.exec(originalGuard);
    await db.exec(trigger);
    if (applied === 'current') await db.exec(guardMigration);
    return db;
  }
  afterAll(async () => { for (const db of opened) await db.close(); });

  test('the migration is LF-exact and replaces only the insert guard', () => {
    expect(guardMigration).not.toContain('\r');
    expect(guardMigration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(guardMigration).toContain('public.objective_strategy_intake_insert_guard()');
  });

  test('the applied guard refuses the shared-intake DTO the application reserves (the preview 503)', async () => {
    const db = await database('original');
    await expect(reserve(db, shapes.intake)).rejects.toThrow('Objective Strategy intake reserved job mismatch');
    expect((await db.query('SELECT count(*)::int AS n FROM client_objective_strategy_intakes')).rows).toEqual([{ n: 0 }]);
  }, 60000);

  test('a shared-intake Objective reserves its job and a legacy Objective is unchanged', async () => {
    const db = await database('current');
    await reserve(db, shapes.intake);
    await reserve(db, shapes.legacy);
    const jobs = await db.query<{ dto: Record<string, unknown> }>(`SELECT input->'dto' AS dto FROM sp_draft_job ORDER BY id`);
    expect(jobs.rows.map(row => row.dto)).toEqual([
      { clientId: client, type: 'appropriations', goal: intake.goal, ownerUserId: clerk, targetDate: intake.targetDate,
        meriContext: intake.meriContext },
      { clientId: client, type: 'appropriations', goal: shapes.legacy.outcome },
    ]);
    expect((await db.query('SELECT count(*)::int AS n FROM client_objective_strategy_intakes')).rows).toEqual([{ n: 2 }]);
  }, 60000);

  test('the guard still refuses a DTO that differs from the saved answers or another selected type', async () => {
    const db = await database('current');
    await expect(reserve(db, shapes.intake, { dto: { clientId: client, type: 'appropriations', goal: '' } }))
      .rejects.toThrow('Objective Strategy intake reserved job mismatch');
    await expect(reserve(db, shapes.intake, { dto: { ...objectiveStrategyDraftInput(client, 'appropriations',
      objectiveIntentFromSnapshot({ strategyIntake: intake })), goal: 'Substituted goal' } }))
      .rejects.toThrow('Objective Strategy intake reserved job mismatch');
    await expect(reserve(db, shapes.intake, { type: 'earmark',
      dto: { clientId: client, type: 'earmark', goal: intake.goal, ownerUserId: clerk, targetDate: intake.targetDate, meriContext: intake.meriContext } }))
      .rejects.toThrow('Objective Strategy intake saved source mismatch');
    await expect(reserve(db, shapes.legacy, { dto: { clientId: client, type: 'appropriations', goal: 'Other' } }))
      .rejects.toThrow('Objective Strategy intake reserved job mismatch');
    expect((await db.query('SELECT count(*)::int AS n FROM client_objective_strategy_intakes')).rows).toEqual([{ n: 0 }]);
  }, 60000);
});
