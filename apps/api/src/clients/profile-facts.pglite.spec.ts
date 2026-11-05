import {
  acceptOfficialProfileFact,
  readOfficialProfileIdentities,
  rejectAutomaticOfficialFact,
  restoreAutomaticOfficialFact,
  isAutomaticOfficialEvidence,
  type OfficialFactProof,
} from './profile-official-facts.js';
import { visibleProfileFindings } from './profile-shared-evidence.js';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { writeProfileFact, assertConflictCurrentFact } from './profile-facts.js';
import { carryProspectProfile } from './profile-conversion.js';
import type { ProfileProjectionService } from './profile-projection.service.js';

const tenant = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000002';
const client = '20000000-0000-4000-8000-000000000001',
  prospect = '20000000-0000-4000-8000-000000000002',
  actor = '30000000-0000-4000-8000-000000000001';
const run = '40000000-0000-4000-8000-000000000001';
const ctx = {
  tenantId: tenant,
  userId: actor,
  clerkUserId: 'test-user',
  tenantSlug: 'fixture',
  role: 'user_admin',
} as TenantContext;
let db: PGlite, tx: Prisma.TransactionClient;
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE tenants(id uuid PRIMARY KEY);CREATE TABLE canonical_entities(id uuid PRIMARY KEY,tenant_id uuid,identity_scope text DEFAULT 'global_public',status text DEFAULT 'active',merged_into_entity_id uuid);
 CREATE TABLE entity_identifiers(entity_id uuid,tenant_id uuid,identity_scope text DEFAULT 'global_public',identifier_type text,normalized_value text,status text DEFAULT 'active',verified_at timestamptz);
 CREATE TABLE client_intel_mapping(tenant_id uuid,client_id uuid,source text,external_id text,confirmed boolean);
 CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;
 CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
 CREATE ROLE capiro_app;
 CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text,website text,description text,product_description text,canonical_entity_id uuid,intake_data_jsonb jsonb DEFAULT '{}',uei text,cage_code text,naics_codes text[] DEFAULT '{}',psc_codes text[] DEFAULT '{}',UNIQUE(tenant_id,id));
 CREATE TABLE business_development_prospects(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),display_name text,website text,description text,canonical_entity_id uuid,UNIQUE(tenant_id,id));
 CREATE TABLE engagement_attachments(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,prospect_id uuid,superseded_by_attachment_id uuid,lifecycle_status text,viewer_mode text DEFAULT 'all');
 CREATE TABLE client_profile_fill_run(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid NOT NULL REFERENCES clients(id),created_by_user_id uuid,source_states_jsonb jsonb DEFAULT '{}',workflow_version int DEFAULT 2,attachment_ids uuid[] DEFAULT '{}',last_progress_at timestamptz,status text DEFAULT 'running',stage text DEFAULT 'research',requested_sources text[] DEFAULT '{}',setup_jsonb jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),cancelled_at timestamptz,completed_at timestamptz,UNIQUE(id,tenant_id,client_id));
 CREATE TABLE client_profile_fill_finding(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text,target_key text,source text,fact_kind text,current_value_jsonb jsonb,proposed_value_jsonb jsonb,evidence_jsonb jsonb DEFAULT '[]',confidence numeric,status text,content_hash text,reviewed_by uuid,reviewed_at timestamptz,rejection_reason text,applied_at timestamptz,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now(),run_id uuid NOT NULL,tenant_id uuid NOT NULL,client_id uuid NOT NULL,UNIQUE(run_id,content_hash),FOREIGN KEY(run_id,tenant_id,client_id)REFERENCES client_profile_fill_run(id,tenant_id,client_id));
 CREATE TABLE client_profile_fill_task(id uuid PRIMARY KEY,run_id uuid NOT NULL,tenant_id uuid NOT NULL,client_id uuid NOT NULL,task_type text,task_key text,input_jsonb jsonb DEFAULT '{}',depends_on uuid[] DEFAULT '{}',max_attempts int,status text DEFAULT 'queued',worker_id text,completed_at timestamptz,updated_at timestamptz DEFAULT now(),FOREIGN KEY(run_id,tenant_id,client_id)REFERENCES client_profile_fill_run(id,tenant_id,client_id));
 CREATE TABLE client_profile_fill_extension_task(LIKE client_profile_fill_task INCLUDING ALL);
 ALTER TABLE client_profile_fill_extension_task ADD FOREIGN KEY(run_id,tenant_id,client_id)REFERENCES client_profile_fill_run(id,tenant_id,client_id);
 INSERT INTO tenants VALUES('${tenant}'),('${other}');INSERT INTO clients(id,tenant_id,name)VALUES('${client}','${tenant}','Legacy client');
 INSERT INTO business_development_prospects(id,tenant_id,display_name)VALUES('${prospect}','${tenant}','Legacy prospect');`);
  await db.exec(
    readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20290110010000_portfolio_subject_facts/migration.sql',
      ),
      'utf8',
    ),
  );
  tx = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await db.query(sql, params)).rows,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await db.query(sql, params)).affectedRows ?? 0,
    businessDevelopmentProspectActivity: { findMany: async () => [] },
  } as unknown as Prisma.TransactionClient;
});
afterEach(async () => {
  await db.close();
});

it('backfills unknown provenance honestly and preserves both subject domains', async () => {
  const { rows } = await db.query<{
    origin: string;
    source_url: null;
    confidence: null;
    approved_at: null;
  }>(`SELECT origin,source_url,confidence,approved_at FROM profile_fact`);
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (r) =>
        r.origin === 'legacy' &&
        r.source_url === null &&
        r.confidence === null &&
        r.approved_at === null,
    ),
  ).toBe(true);
  await expect(
    db.query(
      `INSERT INTO profile_fact(tenant_id,client_id,prospect_id,field_key,value_jsonb,origin,status,origin_id)VALUES($1,$2,$3,'x','1','research','pending','mixed')`,
      [tenant, client, prospect],
    ),
  ).rejects.toThrow();
});
it('enforces tenant-qualified ownership and forced row policies', async () => {
  await expect(
    db.query(
      `INSERT INTO profile_fact(tenant_id,client_id,field_key,value_jsonb,origin,status,origin_id)VALUES($1,$2,'x','1','research','pending','cross')`,
      [other, client],
    ),
  ).rejects.toThrow();
  await db.exec(`SET ROLE capiro_app;SET app.tenant_id='${other}'`);
  expect((await db.query('SELECT id FROM profile_fact')).rows).toHaveLength(0);
  await expect(
    db.query(
      `INSERT INTO profile_fact(tenant_id,client_id,field_key,value_jsonb,origin,status,origin_id)VALUES($1,$2,'x','1','research','pending','denied')`,
      [tenant, client],
    ),
  ).rejects.toThrow();
});
it('allows prospect runs without a Client and rejects mixed-subject task FKs', async () => {
  await db.query(`INSERT INTO client_profile_fill_run(id,tenant_id,prospect_id)VALUES($1,$2,$3)`, [
    run,
    tenant,
    prospect,
  ]);
  await db.query(
    `INSERT INTO client_profile_fill_task(id,run_id,tenant_id,prospect_id)VALUES(gen_random_uuid(),$1,$2,$3)`,
    [run, tenant, prospect],
  );
  await expect(
    db.query(
      `INSERT INTO client_profile_fill_task(id,run_id,tenant_id,client_id)VALUES(gen_random_uuid(),$1,$2,$3)`,
      [run, tenant, client],
    ),
  ).rejects.toThrow();
});
it('keeps person values current while research conflicts and replays remain durable', async () => {
  const subject = { kind: 'client' as const, id: client };
  const person = await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'website',
    value: 'https://person.example',
    origin: 'person',
    originId: 'person-1',
  });
  const proposal = {
    fieldKey: 'website',
    value: 'https://research.example',
    origin: 'research' as const,
    originId: 'research-1',
    sourceUrl: 'https://evidence.example',
    evidence: [{ url: 'https://evidence.example' }],
  };
  const first = await writeProfileFact(tx, ctx, subject, proposal),
    replay = await writeProfileFact(tx, ctx, subject, proposal);
  expect(first.conflict).toBe(true);
  expect(replay.fact.id).toBe(first.fact.id);
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM profile_fact WHERE field_key='website' AND is_current`,
  );
  expect(rows).toEqual([{ id: person.fact.id }]);
  expect((await db.query('SELECT id FROM profile_fact_conflict')).rows).toHaveLength(1);
  await expect(
    writeProfileFact(tx, ctx, subject, { ...proposal, value: 'changed' }),
  ).rejects.toThrow('origin');
});
it('rolls back carried facts and task fencing when canonical projection fails', async () => {
  await db.query(
    `INSERT INTO client_profile_fill_run(id,tenant_id,prospect_id,requested_sources)VALUES($1,$2,$3,ARRAY['public_web'])`,
    [run, tenant, prospect],
  );
  await db.query(
    `INSERT INTO client_profile_fill_task(id,run_id,tenant_id,prospect_id,status,worker_id)VALUES(gen_random_uuid(),$1,$2,$3,'running','attempt-1')`,
    [run, tenant, prospect],
  );
  await db.exec('BEGIN');
  try {
    await carryProspectProfile(tx, ctx, prospect, client, {
      project: async () => {
        throw new Error('projection refused');
      },
    } as unknown as ProfileProjectionService);
    throw new Error('expected refusal');
  } catch (e) {
    expect(String(e)).toContain('projection refused');
    await db.exec('ROLLBACK');
  }
  expect(
    (
      await db.query<{ status: string }>(`SELECT status FROM client_profile_fill_run WHERE id=$1`, [
        run,
      ])
    ).rows[0]?.status,
  ).toBe('running');
  expect(
    (await db.query(`SELECT id FROM profile_fact WHERE origin_id LIKE 'prospect:%'`)).rows,
  ).toHaveLength(0);
});

it('refuses a conflict after a later person edit instead of replacing that edit', async () => {
  const subject = { kind: 'client' as const, id: client };
  const first = await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'website',
    value: 'first',
    origin: 'person',
    originId: 'person-first',
  });
  await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'website',
    value: 'research',
    origin: 'research',
    originId: 'research-conflict',
  });
  await assertConflictCurrentFact(tx, tenant, subject, first.fact.id);
  await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'website',
    value: 'latest',
    origin: 'person',
    originId: 'person-latest',
  });
  await expect(assertConflictCurrentFact(tx, tenant, subject, first.fact.id)).rejects.toThrow(
    'current value changed',
  );
  expect(
    (
      await db.query<{ value_jsonb: string }>(
        `SELECT value_jsonb FROM profile_fact WHERE field_key='website' AND is_current`,
      )
    ).rows[0]?.value_jsonb,
  ).toBe('latest');
});
it('remaps prospect child IDs and durably queues successor tasks plus pending review in conversion', async () => {
  const oldChild = '50000000-0000-4000-8000-000000000001',
    newChild = '50000000-0000-4000-8000-000000000002';
  await writeProfileFact(
    tx,
    ctx,
    { kind: 'prospect', id: prospect },
    {
      fieldKey: `locations.${oldChild}`,
      value: { id: oldChild, name: 'Factory' },
      origin: 'person',
      originId: 'site',
    },
  );
  await db.query(
    `INSERT INTO client_profile_fill_run(id,tenant_id,prospect_id,requested_sources)VALUES($1,$2,$3,ARRAY['public_web'])`,
    [run, tenant, prospect],
  );
  await db.query(
    `INSERT INTO client_profile_fill_task(id,run_id,tenant_id,prospect_id,task_type,task_key,status,worker_id)VALUES(gen_random_uuid(),$1,$2,$3,'public_web','public_web','running','old-attempt')`,
    [run, tenant, prospect],
  );
  await db.query(
    `INSERT INTO client_profile_fill_finding(run_id,tenant_id,prospect_id,kind,target_key,source,fact_kind,proposed_value_jsonb,status,content_hash)VALUES($1,$2,$3,'profile_field','description','public_web','fact','"Sourced description"','pending','hash')`,
    [run, tenant, prospect],
  );
  const project = jest.fn(
    async (_scope: unknown, _ctx: unknown, _subject: unknown, key: string, value: unknown) =>
      key.startsWith('locations.') ? { ...(value as object), id: newChild } : value,
  );
  await db.exec('BEGIN');
  const outcome = await carryProspectProfile(tx, ctx, prospect, client, {
    project,
  } as unknown as ProfileProjectionService);
  await db.exec('COMMIT');
  expect(project.mock.calls.find((call) => call[3].startsWith('locations.'))?.[4]).toEqual({
    name: 'Factory',
  });
  expect(
    (
      await db.query<{ field_key: string; value_jsonb: { id: string } }>(
        `SELECT field_key,value_jsonb FROM profile_fact WHERE client_id=$1 AND field_key LIKE 'locations.%'`,
        [client],
      )
    ).rows[0],
  ).toEqual({ field_key: `locations.${newChild}`, value_jsonb: { name: 'Factory', id: newChild } });
  expect(outcome.successorRunId).toBeTruthy();
  expect(
    (
      await db.query<{ status: string }>(`SELECT status FROM client_profile_fill_run WHERE id=$1`, [
        run,
      ])
    ).rows[0]?.status,
  ).toBe('cancelled');
  expect(
    (
      await db.query<{ status: string; client_id: string }>(
        `SELECT status,client_id FROM client_profile_fill_task WHERE run_id=$1`,
        [outcome.successorRunId],
      )
    ).rows,
  ).toEqual([{ status: 'queued', client_id: client }]);
  expect(
    (
      await db.query<{ status: string }>(
        `SELECT status FROM client_profile_fill_finding WHERE run_id=$1`,
        [outcome.successorRunId],
      )
    ).rows,
  ).toEqual([{ status: 'pending' }]);
});

it('rejects cross-tenant provenance and wrong-subject conflict or attachment links', async () => {
  const otherClient = '60000000-0000-4000-8000-000000000001',
    otherRun = '60000000-0000-4000-8000-000000000002',
    otherDoc = '60000000-0000-4000-8000-000000000003';
  await db.query(`INSERT INTO clients(id,tenant_id,name)VALUES($1,$2,'Other')`, [
    otherClient,
    other,
  ]);
  await db.query(`INSERT INTO client_profile_fill_run(id,tenant_id,client_id)VALUES($1,$2,$3)`, [
    otherRun,
    other,
    otherClient,
  ]);
  await db.query(`INSERT INTO engagement_attachments(id,tenant_id,prospect_id)VALUES($1,$2,NULL)`, [
    otherDoc,
    other,
  ]);
  const insert = `INSERT INTO profile_fact(tenant_id,client_id,field_key,value_jsonb,origin,status,origin_id,run_id,attachment_id)VALUES($1,$2,'x','1','research','pending',$3,$4,$5)`;
  await expect(db.query(insert, [tenant, client, 'wrong-run', otherRun, null])).rejects.toThrow();
  await expect(db.query(insert, [tenant, client, 'wrong-doc', null, otherDoc])).rejects.toThrow();
  const person = await writeProfileFact(
    tx,
    ctx,
    { kind: 'client', id: client },
    { fieldKey: 'website', value: 'client', origin: 'person', originId: 'person' },
  );
  const prospectFact = await writeProfileFact(
    tx,
    ctx,
    { kind: 'prospect', id: prospect },
    { fieldKey: 'website', value: 'prospect', origin: 'person', originId: 'prospect' },
  );
  await expect(
    db.query(
      `INSERT INTO profile_fact_conflict(tenant_id,client_id,field_key,current_fact_id,proposed_fact_id)VALUES($1,$2,'website',$3,$4)`,
      [tenant, client, person.fact.id, prospectFact.fact.id],
    ),
  ).rejects.toThrow();
  await expect(
    db.query(
      `INSERT INTO profile_attachment_link(tenant_id,client_id,prospect_id,attachment_id)VALUES($1,$2,$3,$4)`,
      [tenant, client, prospect, otherDoc],
    ),
  ).rejects.toThrow();
});

it('rechecks current document publication before returning saved finding excerpts', async () => {
  const id = '70000000-0000-4000-8000-000000000001';
  await db.query(
    `INSERT INTO engagement_attachments(id,tenant_id,client_id,lifecycle_status)VALUES($1,$2,$3,'ready')`,
    [id, tenant, client],
  );
  const rows = [
    {
      evidence: [{ metadata: { attachmentId: id }, excerpt: 'Source detail' }],
      proposedValue: 'Pending derived detail',
    },
  ];
  expect(await visibleProfileFindings(tx, ctx, { kind: 'client', id: client }, rows)).toEqual(rows);
  await db.query(`UPDATE engagement_attachments SET viewer_mode='restricted' WHERE id=$1`, [id]);
  expect(await visibleProfileFindings(tx, ctx, { kind: 'client', id: client }, rows)).toEqual([]);
});

it('restoring a rejected finding reopens the person conflict rather than bypassing it', async () => {
  const subject = { kind: 'client' as const, id: client };
  const person = await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'website',
    value: 'person',
    origin: 'person',
    originId: 'manual',
  });
  const input = {
    fieldKey: 'website',
    value: 'research',
    origin: 'research' as const,
    originId: 'finding',
  };
  const rejected = await writeProfileFact(tx, ctx, subject, input);
  await db.query(`UPDATE profile_fact SET status='rejected',version=version+1 WHERE id=$1`, [
    rejected.fact.id,
  ]);
  await db.query(
    `UPDATE profile_fact_conflict SET status='resolved',resolution='keep_current',version=version+1 WHERE proposed_fact_id=$1`,
    [rejected.fact.id],
  );
  const restored = await writeProfileFact(tx, ctx, subject, input);
  expect(restored.conflict).toBe(true);
  expect(restored.fact.status).toBe('pending');
  expect(
    (
      await db.query<{ id: string }>(
        `SELECT id FROM profile_fact WHERE field_key='website' AND is_current`,
      )
    ).rows,
  ).toEqual([{ id: person.fact.id }]);
  expect(
    (
      await db.query<{ status: string; version: number }>(
        `SELECT status,version FROM profile_fact_conflict WHERE proposed_fact_id=$1`,
        [rejected.fact.id],
      )
    ).rows,
  ).toEqual([{ status: 'pending', version: 3 }]);
});

it('corroborating research never downgrades the current person authority', async () => {
  const subject = { kind: 'client' as const, id: client };
  const person = await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'website',
    value: 'person',
    origin: 'person',
    originId: 'manual-authority',
  });
  const matching = await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'website',
    value: 'person',
    origin: 'research',
    originId: 'same-source',
  });
  expect(matching.conflict).toBe(false);
  expect(matching.fact.isCurrent).toBe(false);
  const changed = await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'website',
    value: 'new source',
    origin: 'research',
    originId: 'different-source',
  });
  expect(changed.conflict).toBe(true);
  expect(
    (
      await db.query<{ id: string }>(
        `SELECT id FROM profile_fact WHERE field_key='website' AND is_current`,
      )
    ).rows,
  ).toEqual([{ id: person.fact.id }]);
});

it('allows original document deletion while retaining approved facts and unavailable source identity', async () => {
  const id = '80000000-0000-4000-8000-000000000001';
  await db.query(
    `INSERT INTO engagement_attachments(id,tenant_id,prospect_id,lifecycle_status)VALUES($1,$2,$3,'ready')`,
    [id, tenant, prospect],
  );
  await db.query(
    `INSERT INTO profile_attachment_link(tenant_id,client_id,prospect_id,attachment_id)VALUES($1,$2,$3,$4)`,
    [tenant, client, prospect, id],
  );
  const fact = await writeProfileFact(
    tx,
    ctx,
    { kind: 'client', id: client },
    {
      fieldKey: 'description',
      value: 'Approved published description',
      origin: 'research',
      originId: 'document-approved',
      attachmentId: id,
    },
  );
  await db.query('DELETE FROM engagement_attachments WHERE id=$1', [id]);
  const saved = (
    await db.query<{
      attachment_id: string | null;
      value_jsonb: string;
      evidence_jsonb: unknown[];
    }>(`SELECT attachment_id,value_jsonb,evidence_jsonb FROM profile_fact WHERE id=$1`, [
      fact.fact.id,
    ])
  ).rows[0]!;
  expect(saved.attachment_id).toBeNull();
  expect(saved.value_jsonb).toBe('Approved published description');
  expect(saved.evidence_jsonb).toEqual([
    { label: 'Original source document', metadata: { attachmentId: id } },
  ]);
  expect((await db.query('SELECT * FROM profile_attachment_link')).rows).toEqual([]);
  expect(
    await visibleProfileFindings(tx, ctx, { kind: 'client', id: client }, [
      { evidence: saved.evidence_jsonb },
    ]),
  ).toEqual([]);
});

const officialEntity = '90000000-0000-4000-8000-000000000001';
const officialUei = 'ABCDEFGHIJKL';
async function officialSetup(subject = { kind: 'client' as 'client' | 'prospect', id: client }) {
  await db.query(`INSERT INTO canonical_entities(id)VALUES($1)`, [officialEntity]);
  await db.query(
    `INSERT INTO entity_identifiers(entity_id,identifier_type,normalized_value,verified_at)VALUES($1,'uei',$2,now())`,
    [officialEntity, officialUei],
  );
  await db.query(
    `UPDATE ${subject.kind === 'client' ? 'clients' : 'business_development_prospects'} SET canonical_entity_id=$1 WHERE id=$2`,
    [officialEntity, subject.id],
  );
  await db.query(
    `INSERT INTO client_profile_fill_run(id,tenant_id,${subject.kind === 'client' ? 'client_id' : 'prospect_id'})VALUES($1,$2,$3)`,
    [run, tenant, subject.id],
  );
}
async function officialFinding(
  targetKey = 'cageCode',
  value: unknown = '1AB23',
  kind = 'government_identity',
  source = 'sam_gov',
  subject = { kind: 'client' as 'client' | 'prospect', id: client },
) {
  const result = await db.query<{ id: string }>(
    `INSERT INTO client_profile_fill_finding(tenant_id,${subject.kind === 'client' ? 'client_id' : 'prospect_id'},run_id,kind,target_key,source,proposed_value_jsonb,status,content_hash)VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'pending',gen_random_uuid()::text)RETURNING id`,
    [tenant, subject.id, run, kind, targetKey, source, JSON.stringify(value)],
  );
  return {
    id: result.rows[0]!.id,
    runId: run,
    kind,
    targetKey,
    source,
    proposedValue: value,
    evidence: [{ label: 'Official exact identifier source', source: 'SAM.gov' }],
  };
}
const samProof: OfficialFactProof = {
  kind: 'sam_registration',
  identity: { type: 'uei', value: officialUei },
  sourceRecordId: officialUei,
  sourceUrl: `https://sam.gov/entity/${officialUei}/coreData`,
  observedAt: '2026-11-04T00:00:00.000Z',
};
const officialProject = async (
  _scope: unknown,
  _ctx: unknown,
  _subject: unknown,
  field: string,
  value: unknown,
) => {
  if (field === 'cageCode')
    await db.query('UPDATE clients SET cage_code=$1 WHERE id=$2', [value, client]);
  return value;
};
it('autoaccepts an exact official identifier atomically with its canonical value and explicit machine provenance', async () => {
  await officialSetup();
  const finding = await officialFinding();
  await db.exec('BEGIN');
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      { kind: 'client', id: client },
      finding,
      samProof,
      officialProject,
    ),
  ).toBe('accepted');
  await db.exec('COMMIT');
  expect((await db.query('SELECT cage_code FROM clients WHERE id=$1', [client])).rows).toEqual([
    { cage_code: '1AB23' },
  ]);
  const fact = (
    await db.query<{
      origin: string;
      approved_by: null;
      status: string;
      evidence_jsonb: unknown[];
    }>(`SELECT origin,approved_by,status,evidence_jsonb FROM profile_fact WHERE finding_id=$1`, [
      finding.id,
    ])
  ).rows[0]!;
  expect(fact.origin).toBe('official');
  expect(fact.approved_by).toBeNull();
  expect(fact.status).toBe('approved');
  expect(isAutomaticOfficialEvidence(fact.evidence_jsonb)).toBe(true);
  expect(
    (
      await db.query(`SELECT status,reviewed_by FROM client_profile_fill_finding WHERE id=$1`, [
        finding.id,
      ])
    ).rows,
  ).toEqual([{ status: 'accepted', reviewed_by: null }]);
});
it('does not autoaccept inferred fields, name matches, mismatched exact identifiers, or withdrawn canonical evidence', async () => {
  await officialSetup();
  const inferred = await officialFinding('naicsCodes', ['541330']);
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      { kind: 'client', id: client },
      inferred,
      samProof,
      officialProject,
    ),
  ).toBe('pending');
  const finding = await officialFinding();
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      { kind: 'client', id: client },
      finding,
      { ...samProof, identity: { type: 'uei', value: 'ZZZZZZZZZZZZ' } },
      officialProject,
    ),
  ).toBe('pending');
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      { kind: 'client', id: client },
      { ...finding, source: 'public_web' },
      samProof,
      officialProject,
    ),
  ).toBe('pending');
  await db.query(`UPDATE entity_identifiers SET status='withdrawn'`);
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      { kind: 'client', id: client },
      finding,
      samProof,
      officialProject,
    ),
  ).toBe('pending');
  expect((await db.query(`SELECT id FROM profile_fact WHERE origin='official'`)).rows).toEqual([]);
});
it('keeps a person conflict pending even when the official registration matches the exact UEI', async () => {
  await officialSetup();
  await writeProfileFact(
    tx,
    ctx,
    { kind: 'client', id: client },
    { fieldKey: 'cageCode', value: 'OTHER', origin: 'person', originId: 'person-cage' },
  );
  await db.query('UPDATE clients SET cage_code=$1 WHERE id=$2', ['OTHER', client]);
  const finding = await officialFinding();
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      { kind: 'client', id: client },
      finding,
      samProof,
      officialProject,
    ),
  ).toBe('pending');
  expect(
    (
      await db.query(
        `SELECT value_jsonb FROM profile_fact WHERE field_key='cageCode' AND is_current`,
      )
    ).rows,
  ).toEqual([{ value_jsonb: 'OTHER' }]);
  expect(
    (await db.query(`SELECT id FROM profile_fact_conflict WHERE status='pending'`)).rows,
  ).toHaveLength(1);
});
it('rolls back automatic fact acceptance when the canonical projection fails', async () => {
  await officialSetup();
  const finding = await officialFinding();
  await db.exec('BEGIN');
  await expect(
    acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      { kind: 'client', id: client },
      finding,
      samProof,
      async () => {
        throw new Error('projection refused');
      },
    ),
  ).rejects.toThrow('projection refused');
  await db.exec('ROLLBACK');
  expect(
    (await db.query(`SELECT id FROM profile_fact WHERE finding_id=$1`, [finding.id])).rows,
  ).toEqual([]);
  expect(
    (await db.query(`SELECT status FROM client_profile_fill_finding WHERE id=$1`, [finding.id]))
      .rows,
  ).toEqual([{ status: 'pending' }]);
});
it('Not right reverses only the current automatic value and rejection memory blocks automatic refresh', async () => {
  await officialSetup();
  const finding = await officialFinding();
  const subject = { kind: 'client' as const, id: client };
  await acceptOfficialProfileFact(
    { tx, afterCommit: [] },
    ctx,
    subject,
    finding,
    samProof,
    officialProject,
  );
  expect(
    await rejectAutomaticOfficialFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      finding.id,
      'Wrong registration',
      officialProject,
    ),
  ).toBe(true);
  expect((await db.query('SELECT cage_code FROM clients WHERE id=$1', [client])).rows).toEqual([
    { cage_code: null },
  ]);
  const refreshed = await officialFinding();
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      refreshed,
      samProof,
      officialProject,
    ),
  ).toBe('rejected');
  expect(await restoreAutomaticOfficialFact(tx, ctx, subject, finding.id)).toBe(true);
  const restored = (
    await db.query<{ status: string; evidence_jsonb: unknown[] }>(
      `SELECT status,evidence_jsonb FROM client_profile_fill_finding WHERE id=$1`,
      [finding.id],
    )
  ).rows[0]!;
  expect(restored.status).toBe('pending');
  expect(isAutomaticOfficialEvidence(restored.evidence_jsonb)).toBe(false);
});
it('rejecting an old automatic fact never undoes a later person edit', async () => {
  await officialSetup();
  const finding = await officialFinding();
  const subject = { kind: 'client' as const, id: client };
  await acceptOfficialProfileFact(
    { tx, afterCommit: [] },
    ctx,
    subject,
    finding,
    samProof,
    officialProject,
  );
  await writeProfileFact(tx, ctx, subject, {
    fieldKey: 'cageCode',
    value: 'MANUL',
    origin: 'person',
    originId: 'later-person',
  });
  await db.query('UPDATE clients SET cage_code=$1 WHERE id=$2', ['MANUL', client]);
  expect(
    await rejectAutomaticOfficialFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      finding.id,
      undefined,
      officialProject,
    ),
  ).toBe(true);
  expect((await db.query('SELECT cage_code FROM clients WHERE id=$1', [client])).rows).toEqual([
    { cage_code: 'MANUL' },
  ]);
});
it('accepts exact recipient awards and confirmed LDA filings while unconfirmed LDA selections remain review-only', async () => {
  const subject = { kind: 'prospect' as const, id: prospect };
  await officialSetup(subject);
  const award = await officialFinding(
    'federal_footprint.federal_award:award-1',
    { awardId: 'award-1', recipientUei: officialUei },
    'profile_field',
    'sam_gov',
    subject,
  );
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      award,
      {
        kind: 'federal_award',
        identity: { type: 'uei', value: officialUei },
        sourceRecordId: 'award-1',
        sourceUrl: 'https://www.usaspending.gov/award/award-1',
        observedAt: samProof.observedAt,
      },
      async () => undefined,
    ),
  ).toBe('accepted');
  const lda = await officialFinding(
    'lda-history:12',
    { externalId: '12', filings: [{ filingUuid: 'official-filing' }] },
    'lda_history',
    'lda',
    subject,
  );
  const proof: OfficialFactProof = {
    kind: 'lda_filings',
    identity: { type: 'lda_client_id', value: '12' },
    sourceRecordId: '12',
    sourceUrl: 'https://lda.senate.gov/api/v1/filings/?client_id=12',
    observedAt: samProof.observedAt,
  };
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      lda,
      proof,
      async () => undefined,
    ),
  ).toBe('pending');
  await db.query(
    `INSERT INTO entity_identifiers(entity_id,identifier_type,normalized_value,verified_at)VALUES($1,'lda_client_id','12',now())`,
    [officialEntity],
  );
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      lda,
      proof,
      async () => undefined,
    ),
  ).toBe('accepted');
  expect(
    (await readOfficialProfileIdentities(tx, ctx, subject)).map((row) => row.type).sort(),
  ).toEqual(['lda_client_id', 'uei']);
});

it('refreshes same-source automatic facts but never revives a superseded value that was later rejected', async () => {
  await officialSetup();
  const subject = { kind: 'client' as const, id: client },
    first = await officialFinding();
  await acceptOfficialProfileFact(
    { tx, afterCommit: [] },
    ctx,
    subject,
    first,
    samProof,
    officialProject,
  );
  const updated = await officialFinding('cageCode', '4CD56');
  expect(
    await acceptOfficialProfileFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      updated,
      samProof,
      officialProject,
    ),
  ).toBe('accepted');
  expect(
    await rejectAutomaticOfficialFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      first.id,
      undefined,
      officialProject,
    ),
  ).toBe(true);
  expect(
    await rejectAutomaticOfficialFact(
      { tx, afterCommit: [] },
      ctx,
      subject,
      updated.id,
      undefined,
      officialProject,
    ),
  ).toBe(true);
  expect(
    (await db.query(`SELECT id FROM profile_fact WHERE field_key='cageCode' AND is_current`)).rows,
  ).toEqual([]);
  expect((await db.query('SELECT cage_code FROM clients WHERE id=$1', [client])).rows).toEqual([
    { cage_code: null },
  ]);
});
