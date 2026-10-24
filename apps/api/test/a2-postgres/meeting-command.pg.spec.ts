import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  commitMeetingCommand,
  readMeetingCommand,
  meetingCommandResult,
} from '../../src/engagement/meeting-command.js';
import type { MeetingCommand } from '../../src/engagement/meeting-command.input.js';
import {
  fixture,
  id,
  tenant,
  actor,
  client,
  ctx,
  foreign,
  outsider,
  release,
  settled,
} from './fixture.js';

let h: Awaited<ReturnType<typeof fixture>>;
const meetingId = id(910);
const revision = '2026-10-24T12:00:00.000Z';
const input = {
  schemaVersion: 1,
  requestId: id(911),
  operation: 'create',
  meetingId: null,
  expectedClientId: null,
  expectedRevision: null,
  meeting: {
    subject: 'Synthetic meeting',
    description: null,
    location: null,
    startsAt: revision,
    endsAt: '2026-10-24T13:00:00.000Z',
    assignClient: true,
    clientId: client,
  },
  artifact: null,
  artifacts: [],
};
const migration = () =>
  readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20281024080000_meeting_command_receipts/migration.sql',
    ),
    'utf8',
  );
// The domain owner and PrismaService are real. The supplied writer makes one
// actual SQL mutation; existing service lifecycle tests cover its UI operations.
async function write(
  tx: Prisma.TransactionClient,
  current: TenantContext,
  command: MeetingCommand,
) {
  await tx.$executeRaw`INSERT INTO meetings(id,tenant_id,client_id,created_by_user_id,subject,updated_at)
    VALUES (${meetingId}::uuid,${current.tenantId}::uuid,${client}::uuid,${current.userId}::uuid,${command.meeting!.subject},${new Date(revision)})`;
  return meetingCommandResult(tx, current, command, meetingId);
}
const create = (value: unknown = input) => commitMeetingCommand(h.prisma, ctx, value, write);
const read = () => readMeetingCommand(h.prisma, ctx, input.requestId);
const counts = async () =>
  (
    await h.sql(`SELECT
  (SELECT count(*)::int FROM meetings) AS meetings,
  (SELECT count(*)::int FROM meeting_command_receipts) AS receipts,
  (SELECT count(*)::int FROM audit_logs) AS audits`)
  ).rows[0];

beforeAll(async () => {
  h = await fixture('files');
  try {
    await h.sql(`
      CREATE TABLE engagement_connections (id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),created_by_user_id uuid);
      CREATE TABLE meetings (id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        client_id uuid,created_by_user_id uuid,connection_id uuid REFERENCES engagement_connections(id),
        subject text NOT NULL,status text NOT NULL DEFAULT 'scheduled',updated_at timestamptz NOT NULL);
      CREATE TABLE meeting_notes (id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,updated_at timestamptz NOT NULL);
      CREATE TABLE audit_logs (id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor_user_id uuid,actor_role text,action text NOT NULL,entity_type text,entity_id text,
        before_jsonb jsonb,after_jsonb jsonb,ip text,user_agent text,request_id text,occurred_at timestamptz DEFAULT now());
      DO $$ DECLARE t text; BEGIN
        FOREACH t IN ARRAY ARRAY['engagement_connections','meetings','meeting_notes','audit_logs'] LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
          EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
          EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id())',t);
          EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO capiro_app',t);
        END LOOP;
      END $$;
    `);
    await h.sql(migration());
    await h.sql(migration());
  } catch (error) {
    await h.close();
    throw error;
  }
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});

it('serializes concurrent retries into one mutation, audit and historical receipt', async () => {
  const [a, b] = await Promise.all([create(), create()]);
  expect(a.receipt).toEqual(b.receipt);
  expect([a.fresh, b.fresh].sort()).toEqual([false, true]);
  expect(await read()).toEqual(a.receipt);
  expect(await counts()).toEqual({ meetings: 1, receipts: 1, audits: 1 });
  await h.sql('DELETE FROM meetings');
  expect(await create()).toMatchObject({
    fresh: false,
    receipt: { ...a.receipt, available: false },
  });
  expect(await counts()).toEqual({ meetings: 0, receipts: 1, audits: 1 });
});

it('rejects a changed payload without replacing the committed outcome', async () => {
  const original = await create();
  await expect(
    create({ ...input, meeting: { ...input.meeting, subject: 'Changed' } }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await read()).toEqual(original.receipt);
  expect(await counts()).toEqual({ meetings: 1, receipts: 1, audits: 1 });
});

it('rolls back a known failed write and consumes that key with a replayable refusal', async () => {
  const failed = await commitMeetingCommand(h.prisma, ctx, input, async (...args) => {
    await write(...args);
    throw new ConflictException('Synthetic late domain refusal');
  });
  expect(failed).toMatchObject({ fresh: false, receipt: { status: 'refused', result: null } });
  expect(await counts()).toEqual({ meetings: 0, receipts: 1, audits: 0 });
  expect(await create()).toEqual(failed);
  expect(await read()).toEqual(failed.receipt);
});

it.each(['meeting_command_receipts', 'audit_logs'])(
  'rolls back effects on %s insertion failure and retries the original key',
  async (table) => {
    await h.sql(`CREATE FUNCTION synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_fail()`);
    try {
      await expect(create()).rejects.toThrow();
      expect(await counts()).toEqual({ meetings: 0, receipts: 0, audits: 0 });
      await expect(read()).rejects.toMatchObject({ status: 404 });
    } finally {
      await h.sql(`DROP TRIGGER synthetic_failure ON ${table}; DROP FUNCTION synthetic_fail()`);
    }
    expect(await create()).toMatchObject({ fresh: true, receipt: { status: 'completed' } });
  },
);

it('rechecks member and wall for replay and lookup and keeps another actor isolated', async () => {
  await create();
  await expect(
    readMeetingCommand(
      h.prisma,
      { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' },
      input.requestId,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readMeetingCommand(h.prisma, { ...ctx, tenantId: foreign }, input.requestId),
  ).rejects.toMatchObject({ status: 404 });
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  await expect(read()).rejects.toMatchObject({ status: 404 });
  await expect(create()).rejects.toMatchObject({ status: 404 });
  await h.sql('UPDATE clients SET memory_wall=false WHERE id=$1', [client]);
  await h.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
  await expect(read()).rejects.toMatchObject({ status: 404 });
  await expect(create()).rejects.toMatchObject({ status: 404 });
});

it.each(['member', 'wall', 'role'])(
  'observes %s revocation committed while waiting for the parent lock',
  async (change) => {
    await create();
    const blocker = await h.lock('SELECT id FROM meetings WHERE id=$1 FOR UPDATE', [meetingId]);
    const writer = jest.fn(write);
    const pending = settled(
      commitMeetingCommand(
        h.prisma,
        ctx,
        {
          ...input,
          requestId: id(912),
          operation: 'update',
          meetingId,
          expectedClientId: client,
          expectedRevision: revision,
        },
        writer,
      ),
    );
    try {
      await h.waitForLock('FOR UPDATE');
      if (change === 'member')
        await h.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
      if (change === 'wall')
        await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
      if (change === 'role')
        await h.sql("UPDATE tenant_memberships SET role='client_portal_user' WHERE user_id=$1", [
          actor,
        ]);
    } finally {
      await release(blocker);
    }
    expect((await pending).error).toMatchObject({ status: change === 'role' ? 403 : 404 });
    expect(writer).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ meetings: 1, receipts: 1, audits: 1 });
  },
);

it('refuses a stale selected artifact before the writer', async () => {
  await create();
  await h.sql('INSERT INTO meeting_notes VALUES($1,$2,$3,$4)', [
    id(913),
    tenant,
    meetingId,
    '2026-10-24T12:01:00Z',
  ]);
  const writer = jest.fn(write);
  const outcome = await commitMeetingCommand(
    h.prisma,
    ctx,
    {
      ...input,
      requestId: id(914),
      operation: 'note-approve',
      meetingId,
      expectedClientId: client,
      expectedRevision: revision,
      meeting: null,
      artifact: { id: id(913), revision, body: null, confidential: null },
    },
    writer,
  );
  expect(outcome.receipt.status).toBe('refused');
  expect(writer).not.toHaveBeenCalled();
});

it('enforces immutable outcomes, tenant RLS and repeatable migration without loss', async () => {
  const first = await create();
  await expect(
    h.prisma.withTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM meeting_command_receipts`),
  ).rejects.toThrow();
  await expect(
    h.prisma.withTenant(
      tenant,
      (tx) => tx.$executeRaw`UPDATE meeting_command_receipts SET message='changed'`,
    ),
  ).rejects.toThrow();
  await expect(
    h.sql("UPDATE meeting_command_receipts SET payload_digest=repeat('0',64)"),
  ).rejects.toThrow('immutable');
  expect(
    await h.prisma.withTenant(
      foreign,
      (tx) => tx.$queryRaw`SELECT * FROM meeting_command_receipts`,
    ),
  ).toEqual([]);
  await expect(
    h.prisma.withTenant(
      foreign,
      (tx) => tx.$executeRaw`INSERT INTO meeting_command_receipts
    (tenant_id,actor_user_id,request_id,payload_digest,operation,client_ids,status,message)
    VALUES (${tenant}::uuid,${actor}::uuid,${id(919)}::uuid,${'0'.repeat(64)},'create',ARRAY[]::uuid[],'refused','denied')`,
    ),
  ).rejects.toThrow();
  await expect(
    h.sql(
      "INSERT INTO meeting_command_receipts(tenant_id,actor_user_id,request_id,payload_digest,operation,client_ids,status) VALUES($1,$2,$3,repeat('0',64),'create',ARRAY[]::uuid[],'refused')",
      [tenant, actor, id(920)],
    ),
  ).rejects.toThrow();
  await h.sql(migration());
  expect(await read()).toEqual(first.receipt);
});
