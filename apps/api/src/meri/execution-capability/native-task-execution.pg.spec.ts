import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import type { ApplicationCurrentService } from '../../auth/application-current.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import type { NativeApprovalMetadataVerifier } from '../native-approvals/native-approval-metadata.js';
import { nativeCanonicalSha256, type NativeApprovalProposal, type NativeCommand } from '../native-approvals/native-approval.contract.js';
import { MeriExecutionReceiverService } from './meri-execution-receiver.service.js';
import { fixture, id, tenant, actor, client, outsider, foreign, ctx, release, settled } from '../../../test/a2-postgres/fixture.js';

// Explicitly allocated, disposable PostgreSQL16 only. Reuses the existing A2
// bootstrap guard, restricted application role, actual PrismaService and lock
// observations. The default unit suite reports these integration cases skipped.
const pgDescribe = process.env.A2_PG_FIXTURE === '1' ? describe : describe.skip;
pgDescribe('native task receiver — actual PostgreSQL effect and receipt', () => {
  let h: Awaited<ReturnType<typeof fixture>>;
  let engagement: EngagementService;
  let approvals: NativeApprovalService;
  let receiver: MeriExecutionReceiverService;
  let request: Request;
  let selectedClient: string | null;
  let sequence: number;
  const retained = new Map<string, string>();
  const conversation = id(2000), taskId = id(2001), secondClient = id(2002);
  const principal = { tenantId: tenant, actorId: actor };
  const binding = { ...principal, conversationId: conversation, runId: id(2003),
    attemptId: id(2004), workerId: id(2005), writerFence: 1 };
  const policyRevision = 'native-task-pg-fixture';
  const migration = (name: string) => readFileSync(resolve(__dirname,
    '../../../prisma/migrations', name, 'migration.sql'), 'utf8');
  const execute = (proposal: NativeApprovalProposal) => receiver.nativeTask(request, ctx, { proposal, binding }, 'execute');
  const read = (proposal: NativeApprovalProposal) => receiver.nativeTask(request, ctx, { proposal, binding }, 'read');
  const revoke = (proposal: NativeApprovalProposal) => approvals.revoke(request, ctx, {
    proposalId: proposal.proposalId, commandSha256: proposal.commandSha256, binding, approver: principal,
  });
  const counts = async () => (await h.sql(`SELECT
    (SELECT count(*)::int FROM engagement_tasks) AS tasks,
    (SELECT count(*)::int FROM clio_meri_execution_consumptions) AS receipts,
    (SELECT count(*)::int FROM clio_meri_execution_consumptions WHERE state='COMPLETED') AS completed`)).rows[0];

  async function approve(action: 'task.create' | 'task.update', args: Record<string, unknown>, lifetimeMs = 60_000) {
    const number = sequence++;
    const command: NativeCommand = {
      contractVersion: action === 'task.create' ? '0.1.0' : '0.2.0', commandId: id(number), binding,
      action, arguments: args, attachments: [], idempotencyKey: `native-pg-${number}`,
      scopes: [{ tenantId: tenant, kind: selectedClient === null ? 'private-user' : 'client',
        resourceId: selectedClient ?? actor, policyRevision }],
    };
    const proposal: NativeApprovalProposal = { proposalId: id(number + 1000), command,
      commandSha256: nativeCanonicalSha256(command), createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + lifetimeMs).toISOString(), requiredApprover: principal };
    retained.set(proposal.proposalId, nativeCanonicalSha256(proposal));
    await approvals.record(request, ctx, { proposal, binding, decision: 'approved', approver: principal });
    return proposal;
  }
  const approveCreate = (clientId: string | null = client, lifetimeMs?: number) =>
    approve('task.create', { title: 'Synthetic native task', clientId, dueDate: null }, lifetimeMs);
  const approveUpdate = () => approve('task.update', {
    taskId, mode: 'unconditional_patch', patch: { title: 'Approved update', status: 'done' },
  });
  async function seedTask() {
    await h.sql(`INSERT INTO engagement_tasks(id,tenant_id,client_id,title,owner_user_id,created_by_user_id)
      VALUES($1,$2,$3,'Before update',$4,$4)`, [taskId, tenant, client, actor]);
  }

  beforeAll(async () => {
    h = await fixture('files');
    try {
      // Complete scalar projections used by the real domain owners; unrelated
      // source tables remain the existing A2 minimal historical fixture.
      await h.sql(`CREATE TYPE billing_status AS ENUM ('none','trialing','active','past_due','canceled','comped');
      CREATE TYPE engagement_task_status AS ENUM ('todo','in_progress','done','blocked','canceled');
      ALTER TABLE tenants
        ADD COLUMN slug text NOT NULL DEFAULT 'fixture', ADD COLUMN name text NOT NULL DEFAULT 'Fixture',
        ADD COLUMN plan text, ADD COLUMN settings_jsonb jsonb NOT NULL DEFAULT '{}',
        ADD COLUMN kms_key_arn text, ADD COLUMN soc2_audit_window jsonb, ADD COLUMN clerk_org_id text,
        ADD COLUMN logo_s3_key text, ADD COLUMN logo_content_type text, ADD COLUMN logo_uploaded_at timestamptz,
        ADD COLUMN account_type text, ADD COLUMN plan_tier text NOT NULL DEFAULT 'FOUNDATION',
        ADD COLUMN lda_registrant_id integer, ADD COLUMN lda_registrant_name text,
        ADD COLUMN stripe_customer_id text, ADD COLUMN stripe_subscription_id text,
        ADD COLUMN billing_status billing_status NOT NULL DEFAULT 'none', ADD COLUMN client_slots integer NOT NULL DEFAULT 0,
        ADD COLUMN llm_allowance_usd_per_slot numeric(12,2) NOT NULL DEFAULT 20, ADD COLUMN llm_hard_cap_usd numeric(12,2),
        ADD COLUMN current_period_end timestamptz, ADD COLUMN onboarding_flow_version integer,
        ADD COLUMN trial_ends_at timestamptz, ADD COLUMN price_lock_expires_at timestamptz, ADD COLUMN import_mode text,
        ADD COLUMN courtesy_swap_used boolean NOT NULL DEFAULT false, ADD COLUMN deletion_hold boolean NOT NULL DEFAULT false,
        ADD COLUMN canceled_at timestamptz, ADD COLUMN locked_at timestamptz,
        ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE tenant_memberships ADD COLUMN billing_admin boolean NOT NULL DEFAULT false,
        ADD COLUMN invited_by uuid, ADD COLUMN joined_at timestamptz,
        ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE clients ADD COLUMN name text NOT NULL DEFAULT 'Synthetic client';
      CREATE TABLE clio_conversations (
        id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),user_id uuid NOT NULL REFERENCES users(id),
        client_id uuid REFERENCES clients(id),workspace_id uuid,workspace_key text NOT NULL DEFAULT 'workspace',
        title text NOT NULL DEFAULT 'Synthetic chat',status text NOT NULL DEFAULT 'active',
        nanoclaw_platform_id text,nanoclaw_agent_group_id text,metadata_jsonb jsonb NOT NULL DEFAULT '{}',
        summary text,summary_up_to_message_id uuid,summary_tokens integer,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        archived_at timestamptz,metadata_revision bigint NOT NULL DEFAULT 0,trashed_at timestamptz,restore_until timestamptz);
      CREATE TABLE clio_conversation_bootstrap_receipts (
        tenant_id uuid NOT NULL REFERENCES tenants(id),actor_user_id uuid NOT NULL,request_id uuid NOT NULL,
        scope_kind text NOT NULL,client_id uuid,conversation_id uuid UNIQUE REFERENCES clio_conversations(id),
        created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,actor_user_id,request_id));
      CREATE TABLE engagement_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
        client_id uuid REFERENCES clients(id),meeting_id uuid,contact_id uuid,mail_thread_id uuid,title text NOT NULL,
        description text,owner_user_id uuid REFERENCES users(id),due_date date,status engagement_task_status NOT NULL DEFAULT 'todo',
        source_type text,source_id text,created_by_user_id uuid REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX engagement_tasks_tenant_source_uniq ON engagement_tasks(tenant_id,source_type,source_id)
        WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
      DO $$ DECLARE t text; BEGIN
        FOREACH t IN ARRAY ARRAY['clio_conversations','clio_conversation_bootstrap_receipts','engagement_tasks'] LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
          EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
          EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id())',t);
          EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO capiro_app',t);
        END LOOP;
      END $$;`);
      for (const name of ['20281018010000_clio_meri_approval_decisions',
        '20281018040000_clio_meri_execution_authority', '20281024090000_native_task_receipt_binding'])
        await h.sql(migration(name));

      // These actual EngagementService methods depend only on Prisma. Reuse the
      // Mail PG fixture's prototype construction, avoiding unrelated provider
      // clients. Neither createTask nor updateTask is replaced or spied on.
      engagement = Object.assign(Object.create(EngagementService.prototype), { prisma: h.prisma });
      const metadata = { verify: async (proposal: NativeApprovalProposal) => {
        expect(retained.get(proposal.proposalId)).toBe(nativeCanonicalSha256(proposal));
      } } as unknown as NativeApprovalMetadataVerifier;
      const current = { read: async () => ({ principal, conversationId: conversation,
        selectedClientId: selectedClient, expiresAtMs: Date.now() + 60_000 }) } as unknown as ApplicationCurrentService;
      const session = { readApplicationAuthoritySession: async () => ({ readCurrent: async () => ({
        principal, identityRevision: 'fixture-session', expiresAtMs: Date.now() + 60_000,
      }) }) } as unknown as TenantContextMiddleware;
      approvals = new NativeApprovalService(h.prisma, metadata, current);
      receiver = new MeriExecutionReceiverService(h.prisma, engagement, null, approvals, session);
    } catch (error) { await h.close(); throw error; }
  });
  afterAll(async () => { await h?.close(); });
  beforeEach(async () => {
    await h.reset();
    selectedClient = client; sequence = 3000; retained.clear();
    await h.sql('INSERT INTO clients(id,tenant_id) VALUES($1,$2)', [secondClient, tenant]);
    await h.sql('INSERT INTO clio_conversations(id,tenant_id,user_id,client_id) VALUES($1,$2,$3,$4)',
      [conversation, tenant, actor, client]);
    const secret = 'synthetic-native-pg-service-secret';
    request = { headers: { 'x-internal-service-secret': secret } } as unknown as Request;
    const guard = new ToolServiceSecretGuard(new ConfigService({ NODE_ENV: 'test',
      MERI_TOOLS_REQUIRE_SERVICE_SECRET: true, INTERNAL_SERVICE_SECRET: secret }) as never);
    expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext)).toBe(true);
  });

  it('concurrent same-key creates commit one actual task and one completed native receipt', async () => {
    const proposal = await approveCreate();
    const [first, second] = await Promise.all([execute(proposal), execute(proposal)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'observed', outcome: { result: { title: 'Synthetic native task', clientId: client } } });
    expect(await counts()).toEqual({ tasks: 1, receipts: 1, completed: 1 });
    expect((await h.sql('SELECT jti IS NULL AS native FROM clio_meri_execution_consumptions')).rows).toEqual([{ native: true }]);
    if (!first || !('outcome' in first)) throw new Error('Expected completed task outcome');
    expect(await read(proposal)).toEqual({ state: 'OUTCOME', outcome: first.outcome });
  });

  it('rolls the actual task update and receipt claim back together on completion failure', async () => {
    await seedTask();
    const proposal = await approveUpdate();
    await h.sql(`CREATE FUNCTION synthetic_completion_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic native completion failure'; END $$;
      CREATE TRIGGER synthetic_completion_failure BEFORE UPDATE ON clio_meri_execution_consumptions
        FOR EACH ROW EXECUTE FUNCTION synthetic_completion_failure()`);
    try {
      await expect(execute(proposal)).rejects.toThrow();
      expect((await h.sql('SELECT title,status FROM engagement_tasks')).rows).toEqual([{ title: 'Before update', status: 'todo' }]);
      expect(await counts()).toEqual({ tasks: 1, receipts: 0, completed: 0 });
      expect(await read(proposal)).toBeNull();
    } finally {
      await h.sql('DROP TRIGGER synthetic_completion_failure ON clio_meri_execution_consumptions; DROP FUNCTION synthetic_completion_failure()');
    }
    const result = await execute(proposal);
    expect(result).toMatchObject({ outcome: { result: { id: taskId, title: 'Approved update', status: 'done' } } });
    expect(await execute(proposal)).toEqual(result);
    expect(await counts()).toEqual({ tasks: 1, receipts: 1, completed: 1 });
  });

  it('an earlier real revoke wins the proposal lock and prevents the queued effect', async () => {
    const proposal = await approveCreate();
    const lock = await h.lock(`SELECT pg_advisory_xact_lock(hashtextextended('capiro-meri-execution:' || $1::text || ':' || $2::text,0::bigint))`, [tenant, proposal.proposalId]);
    const revoking = settled(revoke(proposal));
    let executing: ReturnType<typeof settled<Awaited<ReturnType<typeof execute>>>> | undefined;
    try {
      await h.waitForLock('pg_advisory_xact_lock');
      executing = settled(execute(proposal));
      await h.waitForLock('pg_advisory_xact_lock', 2);
    } finally { await release(lock); }
    expect((await revoking).value).toMatchObject({ revoked: true });
    expect((await executing!).error).toMatchObject({ status: 409 });
    expect(await counts()).toEqual({ tasks: 0, receipts: 0, completed: 0 });
  });

  it('an executing update holds the proposal lock through its task write and permits later revoked replay', async () => {
    await seedTask();
    const proposal = await approveUpdate();
    const taskLock = await h.lock('SELECT id FROM engagement_tasks WHERE id=$1 FOR UPDATE', [taskId]);
    const executing = settled(execute(proposal));
    let revoking: ReturnType<typeof settled<Awaited<ReturnType<typeof revoke>>>> | undefined;
    try {
      await h.waitForLock('engagement_tasks');
      revoking = settled(revoke(proposal));
      await h.waitForLock('pg_advisory_xact_lock');
    } finally { await release(taskLock); }
    const result = await executing;
    expect(result.error).toBeUndefined();
    expect((await revoking!).value).toMatchObject({ revoked: true });
    expect(await execute(proposal)).toEqual(result.value);
    expect(await counts()).toEqual({ tasks: 1, receipts: 1, completed: 1 });
  });

  it('rechecks current task ownership after waiting for the task row lock', async () => {
    await seedTask();
    await h.sql('UPDATE engagement_tasks SET client_id=NULL WHERE id=$1', [taskId]);
    const proposal = await approveUpdate();
    const lock = await h.lock('UPDATE engagement_tasks SET owner_user_id=$1 WHERE id=$2', [outsider, taskId]);
    const executing = settled(execute(proposal));
    try { await h.waitForLock('engagement_tasks'); } finally { await release(lock); }
    expect((await executing).error).toMatchObject({ status: 403 });
    expect((await h.sql('SELECT title FROM engagement_tasks')).rows).toEqual([{ title: 'Before update' }]);
    expect(await counts()).toEqual({ tasks: 1, receipts: 0, completed: 0 });
  });

  it('rechecks a wall change after the client lock and allows the actual current grant', async () => {
    const proposal = await approveCreate();
    const lock = await h.lock('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
    const executing = settled(execute(proposal));
    try { await h.waitForLock('clients'); } finally { await release(lock); }
    expect((await executing).error).toMatchObject({ status: 403 });
    expect(await counts()).toEqual({ tasks: 0, receipts: 0, completed: 0 });
    await h.sql('INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)', [tenant, client, actor]);
    expect(await execute(proposal)).toMatchObject({ status: 'observed' });
    await h.sql('DELETE FROM client_memory_access WHERE client_id=$1', [client]);
    await expect(read(proposal)).rejects.toMatchObject({ status: 403 });
    await expect(execute(proposal)).rejects.toMatchObject({ status: 403 });
    expect(await counts()).toEqual({ tasks: 1, receipts: 1, completed: 1 });
  });

  it('replays a completed expired and revoked receipt, while an absent expired command cannot write', async () => {
    const completed = await approveCreate(client, 2500);
    const absent = await approveCreate(client, 2500);
    const result = await execute(completed);
    await revoke(completed);
    await h.sql('SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))) + 0.02)', [absent.expiresAt]);
    expect(await execute(completed)).toEqual(result);
    if (!result || !('outcome' in result)) throw new Error('Expected replayed task outcome');
    expect(await read(completed)).toEqual({ state: 'OUTCOME', outcome: result.outcome });
    await expect(execute(absent)).rejects.toMatchObject({ status: 409 });
    expect(await counts()).toEqual({ tasks: 1, receipts: 1, completed: 1 });
    await h.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
    await expect(read(completed)).rejects.toMatchObject({ status: 403 });
  });

  it('keeps General omitted-client creation personal and refuses owner, scope, and private RP substitutions', async () => {
    selectedClient = null;
    await h.sql('UPDATE clio_conversations SET client_id=NULL');
    await h.sql(`INSERT INTO clio_conversation_bootstrap_receipts(tenant_id,actor_user_id,request_id,scope_kind,conversation_id)
      VALUES($1,$2,$3,'general',$4)`, [tenant, actor, id(2900), conversation]);
    const proposal = await approveCreate(null);
    const result = await execute(proposal);
    expect(result).toMatchObject({ outcome: { result: { clientId: null } } });
    expect((await h.sql('SELECT owner_user_id=$1 AS owned,created_by_user_id=$1 AS authored FROM engagement_tasks', [actor])).rows).toEqual([{ owned: true, authored: true }]);
    await h.sql('UPDATE engagement_tasks SET owner_user_id=$1', [outsider]);
    await expect(read(proposal)).rejects.toMatchObject({ status: 403 });
    await expect(receiver.nativeTask(request, { ...ctx, tenantId: foreign }, { proposal, binding }, 'execute')).rejects.toMatchObject({ status: 403 });
    await expect(receiver.nativeTask(request, { ...ctx, userId: outsider }, { proposal, binding }, 'execute')).rejects.toMatchObject({ status: 403 });

    selectedClient = client;
    await h.sql('UPDATE clio_conversations SET client_id=$1', [client]);
    await seedTask();
    const update = await approveUpdate();
    await h.sql('UPDATE engagement_tasks SET client_id=$1 WHERE id=$2', [secondClient, taskId]);
    await expect(execute(update)).rejects.toMatchObject({ status: 403 });
    await h.sql("UPDATE engagement_tasks SET client_id=$1,source_type='research_portfolio_action',created_by_user_id=$2 WHERE id=$3", [client, outsider, taskId]);
    await expect(execute(update)).rejects.toMatchObject({ status: 404 });
    expect((await h.sql('SELECT title FROM engagement_tasks WHERE id=$1', [taskId])).rows).toEqual([{ title: 'Before update' }]);
    expect(await counts()).toEqual({ tasks: 2, receipts: 1, completed: 1 });
  });

  it('never redispatches an existing incomplete claim', async () => {
    const proposal = await approveCreate();
    await h.prisma.withTenant(tenant, tx => tx.clioMeriExecutionConsumption.create({ data: {
      tenantId: tenant, proposalId: proposal.proposalId, idempotencyKey: proposal.command.idempotencyKey,
      commandSha256: proposal.commandSha256, argumentsSha256: nativeCanonicalSha256(proposal.command.arguments), jti: null,
    } }));
    await expect(execute(proposal)).rejects.toMatchObject({ status: 409 });
    await expect(read(proposal)).rejects.toMatchObject({ status: 409 });
    expect(await counts()).toEqual({ tasks: 0, receipts: 1, completed: 0 });
  });
});
