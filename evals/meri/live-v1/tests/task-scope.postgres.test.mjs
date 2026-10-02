import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { it } from 'node:test';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
it(
  'real task owner: actor assignment, client walls, exact counts and pagination',
  { skip: !configPath, timeout: 60000 },
  async (t) => {
    assert.ok(isAbsolute(configPath));
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 55433);
    assert.equal(cfg.scope, 'owned local disposable test cluster; no AWS connection');
    const { Client } = require('pg');
    const admin = new Client({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
    const schema = 'meri_task_scope_' + randomUUID().replaceAll('-', '');
    let db;
    await admin.connect();
    try {
      const actual = (
        await admin.query(
          "SELECT current_user=$1 AS owner,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory",
          [cfg.user],
        )
      ).rows[0];
      assert.equal(actual.owner, true);
      assert.equal(actual.address, cfg.host);
      assert.equal(actual.port, cfg.port);
      assert.equal(actual.directory.replaceAll('\\', '/'), cfg.dataDirectory.replaceAll('\\', '/'));
      require('ts-node').register({
        project: fileURLToPath(new URL('../../../../apps/api/tsconfig.json', import.meta.url)),
        transpileOnly: true,
        experimentalResolver: true,
      });
      const { EngagementService } = require(
        fileURLToPath(
          new URL('../../../../apps/api/src/engagement/engagement.service.ts', import.meta.url),
        ),
      );
      const { PrismaClient } = require('@prisma/client');
      const { parseMeriTaskReadInput, buildMeriTaskReadResult } = require(
        fileURLToPath(
          new URL('../../../../apps/api/src/meri/meri-task-read.helpers.ts', import.meta.url),
        ),
      );
      const { classifyApiToolReadOutcome } = require('@capiro/shared/meri-read-outcome');
      await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
        CREATE TYPE membership_status AS ENUM ('active','removed');
        CREATE TYPE engagement_task_status AS ENUM ('todo','in_progress','done','blocked','canceled');
        CREATE TABLE tenant_memberships(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,status membership_status);
        CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,name text,status text,memory_wall boolean);
        CREATE TABLE client_memory_access(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,user_id uuid);
        CREATE TABLE engagement_tasks(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,meeting_id uuid,contact_id uuid,mail_thread_id uuid,title text,description text,owner_user_id uuid,due_date date,status engagement_task_status,source_type text,source_id text,created_by_user_id uuid,created_at timestamptz,updated_at timestamptz);`);
      const url = new URL('postgresql://127.0.0.1:55433/' + cfg.database);
      url.username = cfg.user;
      url.password = cfg.password;
      url.searchParams.set('schema', schema);
      db = new PrismaClient({ datasources: { db: { url: url.href } } });
      const ctx = { tenantId: randomUUID(), userId: randomUUID() };
      const otherTenant = randomUUID(),
        otherUser = randomUUID(),
        visible = randomUUID(),
        walled = randomUUID();
      const membership = randomUUID(),
        grant = randomUUID();
      await admin.query("INSERT INTO tenant_memberships VALUES($1,$2,$3,'active')", [
        membership,
        ctx.tenantId,
        ctx.userId,
      ]);
      await admin.query(
        "INSERT INTO clients VALUES($1,$3,'Visible','active',false),($2,$3,'Walled','active',true)",
        [visible, walled, ctx.tenantId],
      );
      const ids = [];
      for (const [tenant, owner, client, status, source] of [
        [ctx.tenantId, ctx.userId, visible, 'todo', null],
        [ctx.tenantId, ctx.userId, null, 'blocked', null],
        [ctx.tenantId, otherUser, visible, 'todo', null],
        [ctx.tenantId, ctx.userId, walled, 'todo', null],
        [otherTenant, ctx.userId, null, 'todo', null],
        [ctx.tenantId, ctx.userId, visible, 'done', null],
        [ctx.tenantId, ctx.userId, null, 'todo', 'research_portfolio_action'],
      ]) {
        const id = randomUUID();
        ids.push(id);
        await admin.query(
          `INSERT INTO engagement_tasks VALUES($1,$2,$3,NULL,NULL,NULL,'Synthetic task',NULL,$4,'2026-10-01',$5,NULLIF($6,''),NULL,$4,'2026-10-01','2026-10-01')`,
          [id, tenant, client, owner, status, source ?? ''],
        );
      }
      const service = Object.assign(Object.create(EngagementService.prototype), {
        prisma: { withTenant: async (_tenant, fn) => db.$transaction(fn, { timeout: 20000 }) },
      });
      const query = {
        clientId: null,
        ownerUserId: ctx.userId,
        taskId: null,
        status: null,
        openOnly: true,
        dueBefore: new Date('2026-10-02T00:00:00Z'),
        offset: 0,
        limit: 1,
      };
      await t.test(
        'counts authorized assignments, not just the first page or other users',
        async () => {
          const page = await service.readMeriTasksExact(ctx, query);
          assert.equal(page.total, 2);
          assert.equal(page.rows.length, 1);
          assert.equal(page.sourceStatus, 'healthy');
          const selection = parseMeriTaskReadInput(
            ctx,
            { assignedToMe: true, status: 'overdue', dueBefore: '2026-10-02T00:00:00Z', limit: 1 },
            null,
            ['todo', 'in_progress', 'blocked', 'done', 'canceled'],
          );
          const result = buildMeriTaskReadResult(ctx, selection, page);
          assert.equal(classifyApiToolReadOutcome('query_tasks', result).kind, 'partial');
          const next = await service.readMeriTasksExact(ctx, { ...query, offset: 1 });
          assert.equal(next.total, 2);
          assert.equal(next.rows.length, 1);
          assert.notEqual(page.rows[0].id, next.rows[0].id);
          assert.deepEqual(new Set([page.rows[0].id, next.rows[0].id]), new Set(ids.slice(0, 2)));
        },
      );
      await t.test(
        'all authorized owners still exclude another tenant, walls and revoked research sources',
        async () => {
          const page = await service.readMeriTasksExact(ctx, {
            ...query,
            ownerUserId: null,
            limit: 50,
          });
          assert.equal(page.total, 3);
          assert.equal(page.rows.length, 3);
          assert.deepEqual(new Set(page.rows.map((row) => row.id)), new Set(ids.slice(0, 3)));
        },
      );
      await t.test('current wall grants affect both exact count and rows', async () => {
        await admin.query('INSERT INTO client_memory_access VALUES($1,$2,$3,$4)', [
          grant,
          ctx.tenantId,
          walled,
          ctx.userId,
        ]);
        assert.equal((await service.readMeriTasksExact(ctx, { ...query, limit: 50 })).total, 3);
        await admin.query('DELETE FROM client_memory_access WHERE id=$1', [grant]);
        assert.equal((await service.readMeriTasksExact(ctx, { ...query, limit: 50 })).total, 2);
      });
      await t.test('archived clients are excluded from both counts and returned data', async () => {
        await admin.query("UPDATE clients SET status='archived' WHERE id=$1", [visible]);
        const page = await service.readMeriTasksExact(ctx, { ...query, limit: 50 });
        assert.equal(page.total, 1);
        assert.equal(page.rows[0].id, ids[1]);
        await admin.query("UPDATE clients SET status='active' WHERE id=$1", [visible]);
      });
      await t.test('revoked membership refuses the read', async () => {
        await admin.query("UPDATE tenant_memberships SET status='removed' WHERE id=$1", [
          membership,
        ]);
        await assert.rejects(service.readMeriTasksExact(ctx, query), /Active tenant membership/);
      });
    } finally {
      await db?.$disconnect();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
