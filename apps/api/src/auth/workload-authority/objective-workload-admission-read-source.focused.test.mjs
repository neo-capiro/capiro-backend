import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

async function moduleUrl(name, replacements = {}) {
  let source = await readFile(new URL(name, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(`from '${from}'`, `from '${to}'`);
  return `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
}
const hashUrl = await moduleUrl('../../clients/objectives/objective-work-intent.ts');
const currentUrl = await moduleUrl('./objective-workload-current.ts', {
  '../../clients/objectives/objective-work-intent.js': hashUrl,
});
const imports = { '../../clients/objectives/objective-work-intent.js': hashUrl,
  './objective-workload-current.js': currentUrl };
const laterUrl = await moduleUrl('./objective-workload-later-current.ts', imports);
const sourceUrl = await moduleUrl('./objective-workload-admission-read-source.ts', {
  ...imports, './objective-workload-later-current.js': laterUrl,
});
const { objectiveRevisionSnapshotHash: hash } = await import(hashUrl);
const { ObjectiveCurrentSourceUnavailable } = await import(currentUrl);
const { loadObjectiveAdmissionReadCurrentFactsWithinTx: load } = await import(sourceUrl);
const denied = error => error instanceof ObjectiveCurrentSourceUnavailable;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1), client = id(2), objective = id(3), jobId = id(4), requestId = id(5);
const actor = id(6), membership = id(7), consent = id(8), delegation = id(9), control = id(15);
const clerk = 'user_original_clerk', policy = 'a'.repeat(64);
const selector = { tenantId: tenant, delegationRef: delegation, consentId: consent,
  generationJobId: jobId, phase: 'admission-read' };
const options = { enabled: true, policyRevision: policy };

test('disabled, unsupported and malformed selectors do not touch SQL', async () => {
  let calls = 0;
  const tx = { async $queryRaw() { calls++; throw new Error('SQL must not run'); } };
  await assert.rejects(load(tx, selector), denied);
  await assert.rejects(load(tx, selector, { ...options, enabled: false }), denied);
  for (const phase of ['admit','publish','request-read','accept','complete','completion-read'])
    await assert.rejects(load(tx, { ...selector, phase }, options), denied);
  await assert.rejects(load(tx, { ...selector, tenantId: 'wrong' }, options), denied);
  let evaluated = false;
  await assert.rejects(load(tx, Object.defineProperty({ ...selector }, 'phase', {
    get() { evaluated = true; return 'admission-read'; }, enumerable: true,
  }), options), denied);
  assert.equal(calls, 0); assert.equal(evaluated, false);
});

test('admission-read SQL adapter uses private custody and original native authority', async t => {
  // In-memory PostgreSQL only. This fixture does not load credentials, connect
  // to a server, execute product migrations or prove runtime grants/RLS.
  const db = new PGlite();
  const now = Date.now();
  const request = { requestId, clientId: client, objective: { objectiveId: objective, objectiveVersion: 1 }, type: 'appropriations' };
  const canonical = { canonicalPlanId: id(10), tenantId: tenant, clientId: client, objectiveId: objective,
    canonicalStrategyId: id(11), canonicalProjectId: id(12), bindingVersion: 1, epoch: 1,
    requestedIntentId: id(13), requestedObjectiveRevisionId: id(14), requestedObjectiveVersion: 1,
    snapshotHash: 'b'.repeat(64) };
  const admission = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1', canonical,
    actorUserId: actor, clerkUserId: clerk, consentId: consent, controlVersion: 1,
    generationJobId: jobId, generationRequestId: requestId, admittedAtMs: now - 50_000,
    effectExpiresAtMs: now - 5_000, expectedStrategyVersionId: null };
  const digest = hash(['objective_canonical_generation_admission',tenant,clerk,jobId]);
  const resourceId = `${digest.slice(0,8)}-${digest.slice(8,12)}-8${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const queries = [];
  const tx = { async $queryRaw(parts, ...values) {
    const sql = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
    queries.push(sql);
    return (await db.query(sql, values)).rows;
  } };
  const insert = async (table, row) => {
    const names = Object.keys(row);
    await db.query(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map((_, i) => `$${i+1}`).join(',')})`, Object.values(row));
  };
  try {
    await db.exec(`
      CREATE TABLE sp_draft_job(id uuid,tenant_id uuid,client_id uuid,owner_user_id text,status text,attempt int,
        claimed_by text,claimed_at timestamptz,strategy_id uuid,request_key text,input jsonb,deadline_at timestamptz);
      CREATE TABLE sp_planner_resources(id uuid,tenant_id uuid,owner_id text,kind text,project_id uuid,
        version int,archived boolean,share_token_hash text,data jsonb);
      CREATE TABLE tenants(id uuid,status text,settings_jsonb jsonb);
      CREATE TABLE tenant_memberships(id uuid,tenant_id uuid,user_id uuid,status text,role text);
      CREATE TABLE users(id uuid,clerk_user_id text);
      CREATE TABLE clients(id uuid,tenant_id uuid,status text,memory_wall boolean);
      CREATE TABLE client_objectives(id uuid,tenant_id uuid,client_id uuid,deleted_at timestamptz);
      CREATE TABLE client_memory_access(id uuid,tenant_id uuid,client_id uuid,user_id uuid);
      CREATE TABLE client_objective_work_consents(id uuid,tenant_id uuid,client_id uuid,objective_id uuid,work_action text,
        control_id uuid,consenting_actor_user_id uuid,consenting_membership_id uuid,canonical_plan_id uuid,canonical_epoch int,
        canonical_strategy_id uuid,canonical_project_id uuid,canonical_binding_version int,root_intent_id uuid,
        source_revision_id uuid,source_objective_version int,source_snapshot_hash text,consent_policy_id text,consent_policy_revision int);
      CREATE TABLE client_objective_workload_delegations(delegation_ref uuid,tenant_id uuid,client_id uuid,objective_id uuid,
        work_action text,control_id uuid,consent_id uuid,control_version int,generation_job_id uuid,generation_request_id uuid,
        generation_request_fingerprint text,job_request_key text,clerk_user_id text,service_subject text,audience text,
        policy_revision text,issued_at timestamptz,absolute_expires_at timestamptz,authority_version int,enabled boolean,cancelled_at timestamptz);
    `);
    await insert('sp_draft_job', { id: jobId, tenant_id: tenant, client_id: client, owner_user_id: clerk,
      status: 'completed', attempt: 2, claimed_by: 'historical', claimed_at: new Date(now-10_000).toISOString(),
      strategy_id: id(11), request_key: `objective-v1:${hash([tenant,clerk,requestId])}`,
      input: JSON.stringify({ objectiveGeneration: { request, fingerprint: hash(request) }, canonicalGeneration: { admissionId: resourceId } }),
      deadline_at: new Date(now-5_000).toISOString() });
    await insert('sp_planner_resources', { id: resourceId, tenant_id: tenant, owner_id: clerk,
      kind: 'objective_canonical_generation_admission', project_id: null, version: 1, archived: false,
      share_token_hash: null, data: JSON.stringify(admission) });
    await insert('tenants', { id: tenant, status: 'active', settings_jsonb: JSON.stringify({ clioFeatureFlags: { 'strategyPlanner.enabled': true } }) });
    await insert('tenant_memberships', { id: membership, tenant_id: tenant, user_id: actor, status: 'active', role: 'standard_user' });
    await insert('users', { id: actor, clerk_user_id: clerk });
    await insert('clients', { id: client, tenant_id: tenant, status: 'active', memory_wall: false });
    await insert('client_objectives', { id: objective, tenant_id: tenant, client_id: client, deleted_at: null });
    await insert('client_objective_work_consents', { id: consent, tenant_id: tenant, client_id: client, objective_id: objective,
      work_action: 'objective.strategy.draft', control_id: control, consenting_actor_user_id: actor, consenting_membership_id: membership,
      canonical_plan_id: id(10), canonical_epoch: 1, canonical_strategy_id: id(11), canonical_project_id: id(12),
      canonical_binding_version: 1, root_intent_id: id(13), source_revision_id: id(14), source_objective_version: 1,
      source_snapshot_hash: 'b'.repeat(64), consent_policy_id: 'capiro.objective-generation-consent', consent_policy_revision: 1 });
    await insert('client_objective_workload_delegations', { delegation_ref: delegation, tenant_id: tenant, client_id: client,
      objective_id: objective, work_action: 'objective.strategy.draft', control_id: control, consent_id: consent, control_version: 1,
      generation_job_id: jobId, generation_request_id: requestId, generation_request_fingerprint: hash(request),
      job_request_key: `objective-v1:${hash([tenant,clerk,requestId])}`, clerk_user_id: clerk,
      service_subject: 'capiro-objective-generation-worker:v1', audience: 'capiro:objective-strategy-api:v1', policy_revision: policy,
      issued_at: new Date(now-60_000).toISOString(), absolute_expires_at: new Date(now+60_000).toISOString(),
      authority_version: 1, enabled: true, cancelled_at: null });
    const scenario = (name, run) => t.test(name, async () => {
      queries.length = 0;
      await db.exec('BEGIN');
      try { await run(); } finally { await db.exec('ROLLBACK'); }
    });
    await scenario('historical read survives effect expiry and returns no acceptance/absence decision', async () => {
      const result = await load(tx, selector, options);
      assert.equal(result.purpose, 'read'); assert.equal(result.acceptedBindingSha256, null);
      assert.equal(result.sourceAdmissionSha256, hash(admission));
      assert.equal(result.actorUserId, actor); assert.equal(result.membershipId, membership);
      assert.ok(result.validUntilMs > result.checkedAtMs);
      assert.ok(result.validUntilMs <= now+60_000);
      assert.equal('acceptance' in result, false);
      assert.deepEqual(queries.map(sql => /^\s*FROM (\w+)/m.exec(sql)?.[1] ?? 'clock'),
        ['sp_draft_job','sp_planner_resources','client_objective_work_consents','client_objective_workload_delegations','clock']);
      assert.match(queries[0], /FOR UPDATE/); assert.match(queries[1], /FOR SHARE/);
      assert.match(queries[2], /FOR SHARE OF cs,t,m,u,c,o/); assert.match(queries[3], /FOR UPDATE/);
    });
    const failures = {
      'another tenant job': `UPDATE sp_draft_job SET tenant_id='${id(99)}'`,
      'another tenant resource': `UPDATE sp_planner_resources SET tenant_id='${id(99)}'`,
      'wrong private owner': `UPDATE sp_planner_resources SET owner_id='other'`,
      'wrong private kind': `UPDATE sp_planner_resources SET kind='task'`,
      'wrong resource id': `UPDATE sp_planner_resources SET id='${id(99)}'`,
      'archived resource': 'UPDATE sp_planner_resources SET archived=true',
      'shared resource': "UPDATE sp_planner_resources SET share_token_hash='shared'",
      'resource version drift': 'UPDATE sp_planner_resources SET version=2',
      'project attached resource': `UPDATE sp_planner_resources SET project_id='${id(99)}'`,
      'extra admission data': `UPDATE sp_planner_resources SET data=data || '{"unexpected":true}'::jsonb`,
      'extra canonical data': `UPDATE sp_planner_resources SET data=jsonb_set(data,'{canonical,unexpected}','true')`,
      'original consent canonical mismatch': `UPDATE client_objective_work_consents SET canonical_plan_id='${id(99)}'`,
      'original consent actor mismatch': `UPDATE client_objective_work_consents SET consenting_actor_user_id='${id(99)}'`,
      'original consent membership mismatch': `UPDATE client_objective_work_consents SET consenting_membership_id='${id(99)}'`,
      'original consent control mismatch': `UPDATE client_objective_work_consents SET control_id='${id(99)}'`,
      'inactive membership': "UPDATE tenant_memberships SET status='inactive'",
      'disallowed role': "UPDATE tenant_memberships SET role='guest'",
      'tenant feature off': "UPDATE tenants SET settings_jsonb='{}'",
      'Clerk actor changed': "UPDATE users SET clerk_user_id='other'",
      'archived client': "UPDATE clients SET status='archived'",
      'deleted objective': 'UPDATE client_objectives SET deleted_at=clock_timestamp()',
      'missing wall membership': 'UPDATE clients SET memory_wall=true',
      'delegation disabled': 'UPDATE client_objective_workload_delegations SET enabled=false',
      'delegation cancelled': 'UPDATE client_objective_workload_delegations SET cancelled_at=clock_timestamp()',
      'delegation expired': "UPDATE client_objective_workload_delegations SET absolute_expires_at=clock_timestamp()-interval '1 second'",
      'policy changed': "UPDATE client_objective_workload_delegations SET policy_revision=repeat('f',64)",
      'duplicate private resource': 'INSERT INTO sp_planner_resources SELECT * FROM sp_planner_resources',
    };
    for (const [name, sql] of Object.entries(failures)) await scenario(name, async () => {
      await db.exec(sql); await assert.rejects(load(tx, selector, options), denied);
    });
    await scenario('current wall membership permits the historical read', async () => {
      await db.exec('UPDATE clients SET memory_wall=true');
      await insert('client_memory_access', { id: id(20), tenant_id: tenant, client_id: client, user_id: actor });
      assert.equal((await load(tx, selector, options)).purpose, 'read');
    });
    await scenario('SQL faults remain faults for caller rollback', async () => {
      const fault = new Error('database unavailable');
      await assert.rejects(load({ $queryRaw: async () => { throw fault; } }, selector, options), error => error === fault);
    });
  } finally { await db.close(); }
});
