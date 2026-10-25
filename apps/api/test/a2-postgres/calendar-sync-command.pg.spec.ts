import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runCalendarCommand,
  readCalendarCommand,
  type CalendarCommandRun,
} from '../../src/engagement/calendar-sync-command.js';
import { fixture, id, tenant, actor, ctx, foreign, outsider, release } from './fixture.js';
let h: Awaited<ReturnType<typeof fixture>>;
const connection = id(1801),
  requestId = id(1802);
const input = { schemaVersion: 1, requestId, range: null };
const progress = (hasMore: boolean) => ({
  pendingPage: { value: [{ id: 'synthetic-source' }] },
  lastStats: {
    scanned: hasMore ? 0 : 1,
    matched: hasMore ? 0 : 1,
    skipped: 0,
    removed: 0,
    failed: 0,
    pages: 1,
    hasMore,
  },
});
const run = (writer: (e: CalendarCommandRun) => Promise<void>, value: unknown = input) =>
  runCalendarCommand(h.prisma, ctx, connection, 'microsoft_365', value, writer);
const read = () => readCalendarCommand(h.prisma, ctx, connection, 'microsoft_365', requestId);
async function write(e: CalendarCommandRun) {
  await e.checkpoint(progress(true));
  await h.prisma.withTenant(tenant, async (tx) => {
    await tx.$executeRaw`INSERT INTO calendar_fixture_effects(tenant_id,request_id) VALUES(${tenant}::uuid,${requestId}::uuid)`;
    await e.checkpoint(progress(false), tx);
  });
  await e.checkpoint(progress(false), undefined, true);
}
const counts = async () =>
  (
    await h.sql(
      'SELECT (SELECT count(*)::int FROM calendar_fixture_effects) effects,(SELECT count(*)::int FROM calendar_sync_commands) commands',
    )
  ).rows[0];
beforeAll(async () => {
  h = await fixture('files');
  try {
    await h.sql(`
      CREATE TYPE engagement_provider AS ENUM ('microsoft_365','google_workspace','imap_caldav','manual');
      CREATE TYPE engagement_connection_status AS ENUM ('needs_configuration','connected','error','disabled');
      CREATE TABLE engagement_connections (
        id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),provider engagement_provider NOT NULL,
        account_email text,display_name text,status engagement_connection_status NOT NULL DEFAULT 'connected',
        scopes text[] NOT NULL DEFAULT '{}',sync_state_jsonb jsonb NOT NULL DEFAULT '{}',last_sync_at timestamptz,
        next_sync_at timestamptz,last_error text,created_by_user_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE engagement_connection_tokens (
        id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),connection_id uuid NOT NULL UNIQUE REFERENCES engagement_connections(id) ON DELETE CASCADE,
        access_token_ciphertext text NOT NULL,access_token_iv text NOT NULL,access_token_auth_tag text NOT NULL,
        refresh_token_ciphertext text,refresh_token_iv text,refresh_token_auth_tag text,key_version text NOT NULL,scopes text[] NOT NULL DEFAULT '{}',
        home_account_id text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE calendar_fixture_effects (tenant_id uuid NOT NULL REFERENCES tenants(id),request_id uuid PRIMARY KEY);
      DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['engagement_connections','engagement_connection_tokens','calendar_fixture_effects'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_tenant_id()) WITH CHECK (tenant_id=current_tenant_id())',t);
        EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO capiro_app',t);
      END LOOP; END $$;
      GRANT SELECT,UPDATE ON tenant_memberships TO capiro_app;
    `);
    await h.sql(
      readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20281024150000_calendar_sync_commands/migration.sql',
        ),
        'utf8',
      ),
    );
  } catch (error) {
    await h.close();
    throw error;
  }
}, 30000);
beforeEach(async () => {
  await h.reset();
  await h.sql(
    "INSERT INTO engagement_connections(id,tenant_id,provider,created_by_user_id) VALUES($1,$2,'microsoft_365',$3)",
    [connection, tenant, actor],
  );
  await h.sql(
    "INSERT INTO engagement_connection_tokens(id,tenant_id,connection_id,access_token_ciphertext,access_token_iv,access_token_auth_tag,key_version,home_account_id,expires_at) VALUES($1,$2,$3,'fixture','fixture','fixture','fixture','fixture-account',now()+interval '1 hour')",
    [id(1803), tenant, connection],
  );
});
afterEach(async () => {
  await h.sql(
    'DROP TRIGGER IF EXISTS calendar_deferred ON calendar_sync_commands; DROP FUNCTION IF EXISTS calendar_deferred_failure();',
  );
});
afterAll(async () => h?.close());
test('ordinary role commits local effect with page progress and immutable completed replay', async () => {
  const writer = jest.fn(write);
  const result = await run(writer);
  expect(result.status).toBe('completed');
  expect(await run(writer)).toEqual(result);
  expect(writer).toHaveBeenCalledTimes(1);
  expect(await counts()).toEqual({ effects: 1, commands: 1 });
  await expect(
    h.prisma.withTenant(
      tenant,
      (tx) => tx.$executeRaw`UPDATE calendar_sync_commands SET status='pending'`,
    ),
  ).rejects.toThrow();
  await expect(
    h.prisma.withTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM calendar_sync_commands`),
  ).rejects.toThrow();
});
test('lost reply after final page commit completes from durable progress without repeating writer', async () => {
  const writer = jest.fn(async (e: CalendarCommandRun) => {
    await write(e);
    throw new Error('reply lost');
  });
  await expect(run(writer)).rejects.toThrow('reply lost');
  expect((await read()).status).toBe('pending');
  expect((await run(writer)).status).toBe('completed');
  expect(writer).toHaveBeenCalledTimes(1);
  expect((await counts()).effects).toBe(1);
});
test('effect and checkpoint rollback together, preserving the original pending page', async () => {
  await expect(
    run(async (e) => {
      await e.checkpoint(progress(true));
      await h.prisma.withTenant(tenant, async (tx) => {
        await tx.$executeRaw`INSERT INTO calendar_fixture_effects(tenant_id,request_id) VALUES(${tenant}::uuid,${requestId}::uuid)`;
        await e.checkpoint(progress(false), tx);
        throw new Error('rollback');
      });
    }),
  ).rejects.toThrow('rollback');
  expect((await counts()).effects).toBe(0);
  expect((await read()).calendar.hasMore).toBe(true);
  expect((await run(write)).status).toBe('completed');
});
test('deferred admission rollback is never acknowledged or followed by provider work', async () => {
  await h.sql(
    "CREATE FUNCTION calendar_deferred_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture deferred'; END $$; CREATE CONSTRAINT TRIGGER calendar_deferred AFTER INSERT ON calendar_sync_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_deferred_failure()",
  );
  const writer = jest.fn(write);
  await expect(run(writer)).rejects.toThrow();
  expect(writer).not.toHaveBeenCalled();
  expect(await counts()).toEqual({ effects: 0, commands: 0 });
});
test('deferred item/checkpoint commit rejection remains pending with no local effect', async () => {
  await h.sql(
    "CREATE FUNCTION calendar_deferred_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.progress_jsonb->'lastStats'->>'hasMore'='false' THEN RAISE EXCEPTION 'fixture deferred'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER calendar_deferred AFTER UPDATE ON calendar_sync_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calendar_deferred_failure()",
  );
  await expect(run(write)).rejects.toThrow();
  expect((await counts()).effects).toBe(0);
  expect((await read()).status).toBe('pending');
  expect((await read()).calendar.hasMore).toBe(true);
});
test('concurrent same request is claimed once and later replays completed history', async () => {
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => (unblock = resolve));
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const writer = jest.fn(async (e: CalendarCommandRun) => {
    entered();
    await gate;
    await write(e);
  });
  const first = run(writer);
  await ready;
  try {
    await expect(run(writer)).rejects.toThrow('already syncing');
  } finally {
    unblock();
  }
  expect((await first).status).toBe('completed');
  expect((await run(writer)).status).toBe('completed');
  expect(writer).toHaveBeenCalledTimes(1);
});
test('another request cannot replace pending provider page evidence', async () => {
  await expect(
    run(async (e) => {
      await e.checkpoint(progress(true));
      throw new Error('pause');
    }),
  ).rejects.toThrow('pause');
  await expect(run(write, { ...input, requestId: id(1804) })).rejects.toThrow('unfinished');
  expect((await counts()).commands).toBe(1);
});
test('current actor, tenant and connection identity constrain historical recovery', async () => {
  await run(write);
  await expect(
    readCalendarCommand(
      h.prisma,
      { ...ctx, userId: outsider },
      connection,
      'microsoft_365',
      requestId,
    ),
  ).rejects.toThrow();
  await expect(
    readCalendarCommand(
      h.prisma,
      { ...ctx, tenantId: foreign },
      connection,
      'microsoft_365',
      requestId,
    ),
  ).rejects.toThrow();
  expect(
    await h.prisma.withTenant(foreign, (tx) => tx.$queryRaw`SELECT * FROM calendar_sync_commands`),
  ).toEqual([]);
  await h.sql("UPDATE engagement_connection_tokens SET home_account_id='replacement'");
  await expect(read()).rejects.toThrow('identity changed');
});
test('membership removed while the connection lock waits prevents admission', async () => {
  const lock = await h.lock('SELECT id FROM engagement_connections WHERE id=$1 FOR UPDATE', [
    connection,
  ]);
  const writer = jest.fn(write);
  const pending = run(writer);
  const caught = pending.catch((e) => e);
  try {
    await h.waitForLock('engagement_connections');
    await h.sql(
      "UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2",
      [tenant, actor],
    );
  } finally {
    await release(lock);
  }
  expect(await caught).toBeInstanceOf(Error);
  expect(writer).not.toHaveBeenCalled();
  expect((await counts()).commands).toBe(0);
});
