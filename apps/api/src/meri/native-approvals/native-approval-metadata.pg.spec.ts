import { PGlite } from '@electric-sql/pglite';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NativeApprovalMetadataVerifier } from './native-approval-metadata.js';
import { nativeCanonicalSha256, type NativeApprovalProposal } from './native-approval.contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const proposalId = '55555555-5555-4555-8555-555555555555';
const commandId = '66666666-6666-4666-8666-666666666666';

function proposal(): NativeApprovalProposal {
  const command = {
    contractVersion: '0.1.0' as const,
    commandId,
    binding: { tenantId, actorId, conversationId, runId,
      attemptId: '77777777-7777-4777-8777-777777777777',
      workerId: '88888888-8888-4888-8888-888888888888', writerFence: 3 },
    action: 'task.create', arguments: { title: 'Prepare follow-up' }, attachments: [],
    scopes: [{ tenantId, kind: 'client', resourceId: 'client-1', policyRevision: 'policy-1' }],
    idempotencyKey: 'intent-1',
  };
  return { proposalId, command, commandSha256: nativeCanonicalSha256(command),
    createdAt: '2026-10-18T10:00:00.000Z', expiresAt: '2026-10-18T10:10:00.000Z',
    requiredApprover: { tenantId, actorId } };
}

function entry(p: NativeApprovalProposal) {
  return { proposal_id: p.proposalId, command_id: p.command.commandId,
    idempotency_key: p.command.idempotencyKey, command_sha256: p.commandSha256,
    record: { proposalId: p.proposalId, commandId: p.command.commandId,
      idempotencyKey: p.command.idempotencyKey, createdAt: p.createdAt, expiresAt: p.expiresAt,
      requiredApprover: p.requiredApprover, binding: p.command.binding, scopes: p.command.scopes } };
}

describe('native approval prepared facts SQL identity', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE core_facts_reader;
      CREATE SCHEMA meri_read_delegation_facts;
      REVOKE ALL ON SCHEMA meri_read_delegation_facts FROM PUBLIC;
      CREATE TABLE private_prepared_run_facts (
        tenant_id text NOT NULL, conversation_id uuid NOT NULL, run_id uuid NOT NULL,
        run_binding jsonb NOT NULL, prepared_approvals jsonb NOT NULL,
        prepared_approvals_overflow boolean NOT NULL
      );
      CREATE VIEW meri_read_delegation_facts.run_facts_v1 WITH (security_barrier = true) AS
        SELECT * FROM private_prepared_run_facts;
      GRANT USAGE ON SCHEMA meri_read_delegation_facts TO core_facts_reader;
      GRANT SELECT ON meri_read_delegation_facts.run_facts_v1 TO core_facts_reader;
    `);
  });

  afterEach(async () => { await db.close(); });

  async function seed(p: NativeApprovalProposal, entries: unknown[] = [entry(p)],
    options: { tenant?: string; actor?: string; conversation?: string; run?: string; overflow?: boolean } = {}) {
    await db.query(`INSERT INTO private_prepared_run_facts
      (tenant_id, conversation_id, run_id, run_binding, prepared_approvals, prepared_approvals_overflow)
      VALUES ($1, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6)`,
    [options.tenant ?? tenantId, options.conversation ?? conversationId, options.run ?? runId,
      JSON.stringify({ ...p.command.binding, actorId: options.actor ?? actorId }),
      JSON.stringify(entries), options.overflow ?? false]);
  }

  function verifier() {
    const tx = { $queryRaw: async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows };
    const prisma = { withTenant: async (tenant: string, fn: (transaction: typeof tx) => Promise<unknown>) => {
      expect(tenant).toBe(tenantId);
      return fn(tx);
    } };
    return { verifier: new NativeApprovalMetadataVerifier(prisma as never), tx };
  }

  it('reads through only the granted view with bound tenant, actor, conversation and run', async () => {
    const p = proposal();
    await seed(p);
    await db.exec('SET ROLE core_facts_reader');
    await expect(db.query('SELECT * FROM private_prepared_run_facts')).rejects.toThrow();
    await expect(verifier().verifier.verify(p)).resolves.toBeUndefined();
  });

  it('refuses a foreign tenant, actor, conversation or run even when its proposal id matches', async () => {
    const p = proposal();
    for (const key of ['tenant', 'actor', 'conversation', 'run'] as const) {
      await db.exec('TRUNCATE private_prepared_run_facts');
      await seed(p, [entry(p)], { [key]: key === 'tenant' ? '99999999-9999-4999-8999-999999999999'
        : key === 'actor' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          : key === 'conversation' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
            : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
      await db.exec('SET ROLE core_facts_reader');
      await expect(verifier().verifier.verify(p)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await db.exec('RESET ROLE');
    }
  });

  it('requires the run projection to retain all four stable identity fields', async () => {
    const p = proposal();
    await seed(p);
    for (const field of ['tenantId', 'conversationId', 'runId'] as const) {
      await db.query(`UPDATE private_prepared_run_facts
        SET run_binding = jsonb_set(run_binding, $1::text[], $2::jsonb)`,
      [[field], JSON.stringify('99999999-9999-4999-8999-999999999999')]);
      await expect(verifier().verifier.verify(p)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await db.query(`UPDATE private_prepared_run_facts
        SET run_binding = jsonb_set(run_binding, $1::text[], $2::jsonb)`,
      [[field], JSON.stringify(p.command.binding[field])]);
    }
  });

  it('fails closed on absent, overflowing or duplicated projection facts', async () => {
    const p = proposal();
    const v = verifier().verifier;
    await expect(v.verify(p)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await seed(p, [entry(p)], { overflow: true });
    await expect(v.verify(p)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await db.exec('TRUNCATE private_prepared_run_facts');
    await seed(p, [entry(p), entry(p)]);
    await expect(v.verify(p)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await db.exec('TRUNCATE private_prepared_run_facts');
    const malformed = entry(p);
    await seed(p, [{ ...malformed, record: { ...malformed.record, extra: true } }]);
    await expect(v.verify(p)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requires the original seven-field binding and relational proposal fields', async () => {
    const p = proposal();
    const altered = entry(p);
    altered.record.binding = { ...p.command.binding, writerFence: 4 };
    await seed(p, [altered]);
    await expect(verifier().verifier.verify(p)).rejects.toBeInstanceOf(ConflictException);
    await db.exec('TRUNCATE private_prepared_run_facts');
    await seed(p, [{ ...entry(p), command_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }]);
    await expect(verifier().verifier.verify(p)).rejects.toBeInstanceOf(ConflictException);
  });
});
