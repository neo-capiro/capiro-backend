import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement/engagement.service.js';
import { ClientProfileFillRelationshipHistoryService } from './client-profile-fill-relationship-history.service.js';
import { readReviewSnapshot } from './client-profile-fill-review-snapshot.js';
import { commitReviewedFindings } from './client-profile-fill-review-store.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const tenant = randomUUID(),
  actor = randomUUID(),
  client = randomUUID(),
  run = randomUUID(),
  thread = randomUUID(),
  finding = randomUUID();
const ctx = {
  tenantId: tenant,
  userId: actor,
  clerkUserId: 'test-clerk',
  tenantSlug: 'test',
  role: 'user_admin',
} as TenantContext;
let db: PGlite,
  tx: Prisma.TransactionClient,
  prisma: PrismaService,
  relationship: ClientProfileFillRelationshipHistoryService;
let failAcceptance = false;
const after = jest.fn();
beforeEach(async () => {
  failAcceptance = false;
  after.mockReset();
  db = new PGlite();
  await db.exec(`CREATE TABLE tenants(id uuid PRIMARY KEY,status text);CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text);CREATE TABLE tenant_memberships(tenant_id uuid,user_id uuid,status text,role text);
 CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,status text,memory_wall boolean DEFAULT false,account_owner_version int DEFAULT 1,account_owner_user_id uuid);
 CREATE TABLE client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);
 CREATE TABLE mail_threads(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,user_id uuid,updated_at timestamptz DEFAULT now(),association_score float);
 CREATE TABLE client_profile_fill_run(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid);
 CREATE TABLE client_profile_fill_finding(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,run_id uuid,kind text,target_key text,source text,fact_kind text,current_value_jsonb jsonb,proposed_value_jsonb jsonb,evidence_jsonb jsonb,confidence float,status text,content_hash text,reviewed_by uuid,reviewed_at timestamptz,applied_at timestamptz,rejection_reason text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE audit_log(id uuid PRIMARY KEY,tenant_id uuid,actor_user_id uuid,action text,entity_id text,after_jsonb jsonb);
 CREATE TABLE association_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payload jsonb);
 INSERT INTO tenants VALUES('${tenant}','active');INSERT INTO users VALUES('${actor}','test-clerk');INSERT INTO tenant_memberships VALUES('${tenant}','${actor}','active','user_admin');INSERT INTO clients(id,tenant_id,status)VALUES('${client}','${tenant}','active');INSERT INTO mail_threads(id,tenant_id,user_id)VALUES('${thread}','${tenant}','${actor}');INSERT INTO client_profile_fill_run VALUES('${run}','${tenant}','${client}');`);
  for (const table of [
    'client_people',
    'client_facilities',
    'client_capabilities',
    'client_intel_mapping',
    'client_advocacy_record',
    'client_advocacy_matter',
    'outcome_event',
  ])
    await db.exec(`CREATE TABLE ${table}(id uuid,tenant_id uuid,client_id uuid)`);
  const query = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const raw = async (q: unknown, ...values: unknown[]) => {
    if (Array.isArray(q))
      return query(
        q.reduce((sql: string, part: string, i: number) => sql + (i ? `$${i}` : '') + part, ''),
        values,
      );
    const statement = q as { text: string; values: unknown[] };
    return query(statement.text, statement.values);
  };
  tx = {
    $queryRaw: raw,
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => query(sql, params),
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (failAcceptance && sql.includes("SET status='accepted'"))
        throw new Error('acceptance failed');
      return (await db.query(sql, params)).affectedRows ?? 0;
    },
    tenantMembership: {
      findFirst: async () =>
        (
          await query(
            `SELECT tm.role FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id JOIN tenants t ON t.id=tm.tenant_id WHERE tm.tenant_id=$1 AND tm.user_id=$2 AND tm.status='active' AND u.clerk_user_id=$3 AND t.status='active'`,
            [tenant, actor, ctx.clerkUserId],
          )
        )[0] ?? null,
    },
    client: {
      findFirst: async ({ where }: { where: { tenantId: string; id: string } }) =>
        (
          await query('SELECT id FROM clients WHERE tenant_id=$1 AND id=$2', [
            where.tenantId,
            where.id,
          ])
        )[0] ?? null,
    },
    mailThread: {
      findFirst: async ({
        where,
      }: {
        where: { tenantId: string; id: string; connection: { createdByUserId: string } };
      }) =>
        (
          await query(
            'SELECT id,client_id AS "clientId",updated_at AS "updatedAt",association_score AS "associationScore" FROM mail_threads WHERE tenant_id=$1 AND id=$2 AND user_id=$3',
            [where.tenantId, where.id, where.connection.createdByUserId],
          )
        )[0] ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { clientId: string } }) =>
        (
          await query(
            "UPDATE mail_threads SET client_id=$2,updated_at=updated_at+interval '1 millisecond' WHERE id=$1 RETURNING id",
            [where.id, data.clientId],
          )
        )[0],
    },
    clientAssociationOverride: {
      create: async ({ data }: { data: unknown }) =>
        (
          await query('INSERT INTO association_overrides(payload)VALUES($1::jsonb)RETURNING id', [
            JSON.stringify(data),
          ])
        )[0],
    },
    auditLog: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
        (
          await query(
            'SELECT id,action,entity_id AS "entityId",actor_user_id AS "actorUserId",after_jsonb AS after FROM audit_log WHERE id=$1 AND tenant_id=$2',
            [where.id, where.tenantId],
          )
        )[0] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) =>
        (
          await query(
            'INSERT INTO audit_log(id,tenant_id,actor_user_id,action,entity_id,after_jsonb)VALUES($1,$2,$3,$4,$5,$6::jsonb)RETURNING id',
            [
              data.id ?? randomUUID(),
              data.tenantId,
              data.actorUserId,
              data.action,
              data.entityId,
              JSON.stringify(data.after),
            ],
          )
        )[0],
    },
  } as unknown as Prisma.TransactionClient;
  prisma = {
    withTenantUser: async (
      _tenant: string,
      _actor: string,
      action: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => {
      await db.exec('BEGIN');
      try {
        const result = await action(tx);
        await db.exec('COMMIT');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as PrismaService;
  const engagement = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(engagement, { afterAssociationOverride: after });
  relationship = new ClientProfileFillRelationshipHistoryService(prisma, engagement);
  const revision = (
    await query('SELECT updated_at AS revision FROM mail_threads WHERE id=$1', [thread])
  )[0]!.revision as Date;
  const proposal = {
    action: 'associate_to_client',
    entityType: 'mail_thread',
    entityId: thread,
    title: 'Relationship meeting',
    occurredAt: revision.toISOString(),
    sourceRevision: revision.toISOString(),
    matchedEmails: ['contact@example.test'],
    matchedDomains: ['example.test'],
    matchReason: 'known_client_contact',
  };
  await db.query(
    `INSERT INTO client_profile_fill_finding(id,tenant_id,client_id,run_id,kind,target_key,source,fact_kind,current_value_jsonb,proposed_value_jsonb,evidence_jsonb,confidence,status,content_hash)VALUES($1,$2,$3,$4,'relationship_link','relationship:test','synced_email','fact','{"clientId":null}',$5::jsonb,$6::jsonb,0.98,'pending','hash')`,
    [
      finding,
      tenant,
      client,
      run,
      JSON.stringify(proposal),
      JSON.stringify([
        { label: 'Mail metadata', metadata: { entityType: 'mail_thread', entityId: thread } },
      ]),
    ],
  );
});
afterEach(async () => {
  await db.close();
});
async function command() {
  const snapshot = await readReviewSnapshot(prisma, ctx, client, run);
  return {
    requestId: randomUUID(),
    expectedClientRevision: snapshot.clientRevision,
    findings: snapshot.findings.map((row) => ({ id: row.id, revision: row.revision })),
  };
}
const apply = (input: Awaited<ReturnType<typeof command>>) =>
  commitReviewedFindings(
    prisma,
    ctx,
    client,
    run,
    input,
    (scope, row) => relationship.applyInTransaction(scope, ctx, client, row),
    { warn: () => undefined },
  );
test('canonical association, audit and finding acceptance commit once and replay without effects', async () => {
  const input = await command();
  const first = await apply(input);
  expect(first.applied).toEqual([finding]);
  expect(after).toHaveBeenCalledTimes(1);
  expect(
    (await db.query<{ client_id: string }>('SELECT client_id FROM mail_threads')).rows[0]
      ?.client_id,
  ).toBe(client);
  expect((await db.query('SELECT id FROM association_overrides')).rows).toHaveLength(1);
  const replay = await apply(input);
  expect(replay).toMatchObject({ replayed: true, applied: [finding] });
  expect(after).toHaveBeenCalledTimes(1);
  expect((await db.query('SELECT id FROM association_overrides')).rows).toHaveLength(1);
});
test('acceptance failure rolls back the canonical association and does not run postcommit work', async () => {
  const input = await command();
  failAcceptance = true;
  const result = await apply(input);
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(
    (await db.query<{ client_id: string | null }>('SELECT client_id FROM mail_threads')).rows[0]
      ?.client_id,
  ).toBeNull();
  expect((await db.query('SELECT id FROM association_overrides')).rows).toHaveLength(0);
  expect(after).not.toHaveBeenCalled();
});
test('source ownership revocation hides saved relationship metadata and prevents application', async () => {
  const input = await command();
  await db.query('UPDATE mail_threads SET user_id=$1', [randomUUID()]);
  expect((await readReviewSnapshot(prisma, ctx, client, run)).findings).toEqual([]);
  const result = await apply(input);
  expect(result.applied).toEqual([]);
  expect(after).not.toHaveBeenCalled();
});
