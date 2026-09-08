/**
 * Fixture-only PostgreSQL validation of the canonical mail query. This executes
 * the source module's actual Prisma SQL against an isolated in-memory database;
 * it never connects to a deployed database or a mail provider.
 *
 * Run with an already available optional PGlite installation:
 *   PGLITE_MODULE_PATH=/path/to/@electric-sql/pglite \
 *     node apps/api/scripts/verify-mail-query-postgres.cjs
 * If PGlite resolves normally, PGLITE_MODULE_PATH can be omitted. No repository
 * dependency or lockfile changes are required. Set MAIL_QUERY_POSTGRES_REPORT_PATH
 * to write the result and the SHA-256 of each executed source module as JSON.
 *
 * Paging excludes rows ingested after asOf. Removals and provider updates can
 * still change existing rows between calls; pages are not a database snapshot.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const repo = process.env.MAIL_QUERY_REPOSITORY_ROOT || path.resolve(__dirname, '../../..');
const apiRequire = createRequire(path.join(repo, 'apps/api/package.json'));
const ts = apiRequire('typescript');
const { PGlite } = require(process.env.PGLITE_MODULE_PATH || '@electric-sql/pglite');
const modules = new Map();
const sourceHashes = {};
function loadTs(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const source = fs.readFileSync(file, 'utf8');
  sourceHashes[path.relative(repo, file)] = createHash('sha256').update(source).digest('hex');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  modules.set(file, mod);
  const localRequire = (name) =>
    name.startsWith('.')
      ? loadTs(path.resolve(path.dirname(file), name.replace(/\.js$/, '.ts')))
      : apiRequire(name);
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: file })(
    localRequire,
    mod,
    mod.exports,
  );
  return mod.exports;
}
const { queryMailMessages } = loadTs(path.join(repo, 'apps/api/src/engagement/mail-query.ts'));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = uuid(1),
  otherTenant = uuid(2),
  user = uuid(3),
  otherUser = uuid(4);
const owned = uuid(10),
  google = uuid(11),
  otherOwned = uuid(12),
  outsider = uuid(13),
  nonMail = uuid(14),
  disconnected = uuid(15);
const asOf = '2026-09-07T12:00:00.000Z';
const ctx = {
  tenantId: tenant,
  userId: user,
  role: 'user',
  requestId: 'mail-query-postgres-regression',
};
const checks = [];
const db = new PGlite();
let queryCount = 0;
const prisma = {
  withTenant: async (id, fn) => {
    assert.equal(id, tenant);
    return fn({
      $queryRaw: async (sql) => {
        queryCount++;
        assert.ok(sql.text.includes('$1'), 'actual parameterized Prisma SQL used');
        return (await db.query(sql.text, sql.values)).rows;
      },
    });
  },
};
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    checks.push({ name, passed: false, error: e.stack });
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
async function insert(table, values) {
  const fields = Object.keys(values),
    vals = Object.values(values);
  await db.query(
    `INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => '$' + (i + 1)).join(',')})`,
    vals,
  );
}
async function message(n, changes = {}) {
  return insert('mail_messages', {
    id: uuid(n),
    tenant_id: tenant,
    connection_id: owned,
    thread_id: uuid(100),
    subject: `Activity ${n}`,
    from_email: 'sender@example.com',
    from_name: 'Sender',
    to_recipients_jsonb: JSON.stringify([{ email: 'owner@example.com', name: 'Owner' }]),
    cc_recipients_jsonb: '[]',
    bcc_recipients_jsonb: '[]',
    sent_at: '2026-09-05T10:00:00Z',
    received_at: '2026-09-05T10:00:00Z',
    body_text: 'Discuss budget review',
    has_attachments: false,
    removed_at: null,
    metadata_jsonb: JSON.stringify({ folder: 'inbox', internetMessageId: `<message-${n}>` }),
    created_at: '2026-09-05T10:01:00Z',
    ...changes,
  });
}
async function run() {
  const version = (await db.query('SELECT version()')).rows[0].version;
  await db.exec(`
    CREATE TABLE engagement_connections (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, created_by_user_id uuid NOT NULL,
      account_email text, provider text, status text, last_sync_at timestamptz, sync_state_jsonb jsonb, created_at timestamptz);
    CREATE TABLE clients (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text);
    CREATE TABLE mail_threads (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, connection_id uuid, client_id uuid);
    CREATE TABLE mail_messages (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, connection_id uuid, thread_id uuid,
      subject text, from_email text, from_name text, to_recipients_jsonb jsonb, cc_recipients_jsonb jsonb, bcc_recipients_jsonb jsonb,
      sent_at timestamptz, received_at timestamptz, body_text text, has_attachments boolean, removed_at timestamptz, metadata_jsonb jsonb,
      created_at timestamptz);
  `);
  const microsoftState = {
    mail: {
      captureVersion: 1,
      updatedAt: '2026-09-07T11:00:00Z',
      folderEnumerationComplete: true,
      folders: {
        inbox: { updatedAt: '2026-09-07T11:00:00Z', deltaLink: 'cursor-inbox' },
        sentitems: { updatedAt: '2026-09-07T11:00:00Z', deltaLink: 'cursor-sent' },
      },
      lastStats: { hasMore: false, failed: 0 },
    },
  };
  const googleState = {
    mail: {
      captureVersion: 1,
      updatedAt: '2026-09-07T11:00:00Z',
      historyId: '102',
      labels: { ALL: { backfillDone: true } },
      lastStats: { hasMore: false, failed: 0 },
    },
  };
  for (const [id, t, u, p, status, state] of [
    [owned, tenant, user, 'microsoft_365', 'connected', microsoftState],
    [google, tenant, user, 'google_workspace', 'connected', googleState],
    [otherOwned, tenant, otherUser, 'microsoft_365', 'connected', microsoftState],
    [outsider, otherTenant, user, 'microsoft_365', 'connected', microsoftState],
    [nonMail, tenant, user, 'zoom', 'connected', {}],
    [disconnected, tenant, user, 'microsoft_365', 'disconnected', microsoftState],
  ])
    await insert('engagement_connections', {
      id,
      tenant_id: t,
      created_by_user_id: u,
      account_email: `mailbox-${id.slice(-2)}@example.com`,
      provider: p,
      status,
      last_sync_at: '2026-09-07T11:55:00Z',
      sync_state_jsonb: JSON.stringify(state),
      created_at: '2026-01-01T00:00:00Z',
    });
  await insert('clients', { id: uuid(200), tenant_id: tenant, name: 'Own client' });
  await insert('clients', {
    id: uuid(201),
    tenant_id: otherTenant,
    name: 'Secret other tenant client',
  });
  for (const [id, t, c, client] of [
    [uuid(100), tenant, owned, null],
    [uuid(101), tenant, google, null],
    [uuid(102), tenant, otherOwned, uuid(200)],
    [uuid(103), otherTenant, outsider, uuid(201)],
    [uuid(104), tenant, nonMail, null],
    [uuid(105), tenant, owned, uuid(200)],
    [uuid(106), tenant, owned, uuid(201)],
  ])
    await insert('mail_threads', { id, tenant_id: t, connection_id: c, client_id: client });
  // Three legitimate, unassociated inbox messages. The first has two provider
  // folder copies and the second has the exact inclusive start timestamp.
  await message(1000, {
    subject: 'Budget review',
    received_at: '2026-09-06T10:00:00Z',
    metadata_jsonb: JSON.stringify({ folder: 'INBOX', internetMessageId: '<duplicate-a>' }),
  });
  await message(1001, {
    subject: 'Budget review',
    received_at: '2026-09-06T10:00:00Z',
    metadata_jsonb: JSON.stringify({ folder: 'inbox', internetMessageId: '<duplicate-a>' }),
  });
  await message(1002, {
    subject: 'Start boundary',
    received_at: '2026-08-24T12:00:00Z',
    sent_at: '2026-08-24T12:00:00Z',
  });
  await message(1003, {
    subject: 'Google inbox',
    connection_id: google,
    thread_id: uuid(101),
    received_at: '2026-09-05T09:00:00Z',
  });
  await message(1100, { subject: 'Old', received_at: '2026-08-24T11:59:59.999Z' });
  await message(1101, {
    subject: 'Sent',
    metadata_jsonb: JSON.stringify({ folder: 'sentitems', internetMessageId: '<sent>' }),
  });
  await message(1102, { subject: 'Future', received_at: '2026-09-07T12:00:00.001Z' });
  await message(1103, { subject: 'Removed', removed_at: '2026-09-07T11:00:00Z' });
  await message(1104, { subject: 'Other user', connection_id: otherOwned, thread_id: uuid(102) });
  await message(1105, {
    subject: 'Other tenant',
    tenant_id: otherTenant,
    connection_id: outsider,
    thread_id: uuid(103),
  });
  await message(1106, { subject: 'Malformed connection tenant', connection_id: outsider });
  await message(1107, { subject: 'Malformed thread tenant', thread_id: uuid(103) });
  await message(1108, {
    subject: 'Not a mail provider',
    connection_id: nonMail,
    thread_id: uuid(104),
  });
  await check(
    'exact two-week inbox request retrieves unassociated mail without synthetic query and excludes old/sent/future/removed/unowned/cross-tenant mail',
    async () => {
      const result = await queryMailMessages(prisma, ctx, {
        withinDays: 14,
        folder: 'inbox',
        asOf,
      });
      assert.equal(result.totalMatches, 3);
      assert.equal(result.returned, 3);
      assert.deepEqual(
        result.messages.map((x) => x.id),
        [uuid(1001), uuid(1003), uuid(1002)],
      );
      assert.ok(result.messages.every((x) => x.client === null));
      assert.deepEqual(result.timeWindow, { start: '2026-08-24T12:00:00.000Z', end: asOf });
      assert.equal(result.folder, 'inbox');
      assert.equal(result.clientId, null);
      assert.equal(result.searchedMailboxes.length, 3); // Includes the owned disconnected store, with truthful unavailable coverage.
      assert.ok(result.searchedMailboxes.every((x) => x.provider !== 'zoom'));
      assert.equal(
        result.searchedMailboxes.find((x) => x.status === 'disconnected').mailCoverage.sourceStatus,
        'unavailable',
      );
    },
  );
  await check(
    'deduplication precedes pagination with stable ordering, count, nextOffset and asOf',
    async () => {
      const filters = { withinDays: 14, folder: 'inbox', asOf, limit: 1 };
      let result = await queryMailMessages(prisma, ctx, filters),
        ids = [];
      while (true) {
        assert.equal(result.totalMatches, 3);
        assert.equal(result.asOf, asOf);
        ids.push(...result.messages.map((x) => x.id));
        if (!result.hasMore) {
          assert.equal(result.nextOffset, null);
          break;
        }
        assert.equal(result.nextOffset, ids.length);
        result = await queryMailMessages(prisma, ctx, { ...filters, offset: result.nextOffset });
      }
      assert.deepEqual(ids, [uuid(1001), uuid(1003), uuid(1002)]);
    },
  );
  await check('same internetMessageId in different owned mailboxes is retained', async () => {
    await message(1200, {
      subject: 'Other mailbox copy',
      connection_id: google,
      thread_id: uuid(101),
      metadata_jsonb: JSON.stringify({ folder: 'inbox', internetMessageId: '<duplicate-a>' }),
    });
    const r = await queryMailMessages(prisma, ctx, { withinDays: 14, folder: 'inbox', asOf });
    assert.equal(r.totalMatches, 4);
    assert.ok(r.messages.some((x) => x.id === uuid(1200)));
  });
  await check('sent and inbox copies deduplicate when all folders are requested', async () => {
    await message(1201, {
      subject: 'Budget review sent copy',
      received_at: '2026-09-06T10:00:00Z',
      metadata_jsonb: JSON.stringify({ folder: 'sent', internetMessageId: '<duplicate-a>' }),
    });
    const r = await queryMailMessages(prisma, ctx, { query: 'Budget review', asOf });
    assert.equal(
      r.messages.filter((x) => [uuid(1000), uuid(1001), uuid(1201)].includes(x.id)).length,
      1,
    );
  });
  await check(
    'literal percent, underscore and backslash search cannot become SQL wildcard patterns',
    async () => {
      await message(1300, {
        subject: 'Budget 100%_approved\\final',
        body_text: 'only exact literal content',
      });
      await message(1301, { subject: 'Budget 100XYZapprovedXfinal', body_text: 'decoy' });
      const r = await queryMailMessages(prisma, ctx, { query: '100%_approved\\final', asOf });
      assert.deepEqual(
        r.messages.map((x) => x.id),
        [uuid(1300)],
      );
    },
  );
  await check(
    'sender and participant searches preserve case insensitive and bcc fragment matching',
    async () => {
      await message(1302, {
        from_email: 'Adam@Example.com',
        from_name: 'Adam Smith',
        bcc_recipients_jsonb: JSON.stringify([
          { email: 'private.person@example.com', name: 'BCC Person' },
        ]),
      });
      assert.deepEqual(
        (await queryMailMessages(prisma, ctx, { from: 'ADAM', asOf })).messages.map((x) => x.id),
        [uuid(1302)],
      );
      assert.deepEqual(
        (
          await queryMailMessages(prisma, ctx, { participant: 'private.person', asOf })
        ).messages.map((x) => x.id),
        [uuid(1302)],
      );
    },
  );
  await check(
    'explicit client filter remains usable without implicitly narrowing unassociated mail',
    async () => {
      await message(1303, { thread_id: uuid(105) });
      const r = await queryMailMessages(prisma, ctx, {
        withinDays: 14,
        folder: 'inbox',
        clientId: uuid(200),
        asOf,
      });
      assert.deepEqual(
        r.messages.map((x) => x.id),
        [uuid(1303)],
      );
      assert.equal(r.messages[0].client.name, 'Own client');
    },
  );
  await check('malformed same-tenant foreign-owner thread join is excluded', async () => {
    await message(1400, { subject: 'Malformed thread connection', thread_id: uuid(102) });
    const r = await queryMailMessages(prisma, ctx, { query: 'Malformed thread connection', asOf });
    assert.equal(r.totalMatches, 0);
    assert.equal(r.messages.length, 0);
  });
  await check('malformed client tenant does not expose another tenant client name', async () => {
    await message(1401, { subject: 'Malformed client', thread_id: uuid(106) });
    const r = await queryMailMessages(prisma, ctx, { query: 'Malformed client', asOf });
    assert.equal(r.messages[0]?.client?.name ?? null, null);
  });
  await check(
    'date-only bounded search is accepted; unconstrained search and cursor missing asOf are rejected before SQL',
    async () => {
      assert.equal(
        (await queryMailMessages(prisma, ctx, { withinDays: 14, asOf })).error,
        undefined,
      );
      const before = queryCount;
      assert.match((await queryMailMessages(prisma, ctx, {})).error, /Provide at least/);
      assert.match(
        (await queryMailMessages(prisma, ctx, { withinDays: 14, offset: 1 })).error,
        /asOf/,
      );
      assert.equal(queryCount, before);
    },
  );
  await check(
    'concurrent backfill cannot insert historical messages into an existing page window; a fresh query sees them',
    async () => {
      await message(1500, {
        subject: 'Concurrent replay first',
        received_at: '2026-09-06T14:00:00Z',
      });
      await message(1501, {
        subject: 'Concurrent replay second',
        received_at: '2026-09-06T13:00:00Z',
      });
      const filters = {
        query: 'Concurrent replay',
        withinDays: 14,
        folder: 'inbox',
        asOf,
        limit: 1,
      };
      const first = await queryMailMessages(prisma, ctx, filters);
      assert.equal(first.totalMatches, 2);
      assert.equal(first.nextOffset, 1);
      assert.equal(first.messages[0].id, uuid(1500));
      await message(1502, {
        subject: 'Concurrent replay backfill',
        received_at: '2026-09-06T15:00:00Z',
        created_at: '2026-09-07T12:05:00Z',
      });
      const second = await queryMailMessages(prisma, ctx, { ...filters, offset: first.nextOffset });
      assert.equal(second.totalMatches, 2);
      assert.equal(second.messages[0].id, uuid(1501));
      assert.equal(second.hasMore, false);
      const fresh = await queryMailMessages(prisma, ctx, {
        ...filters,
        asOf: '2026-09-07T12:10:00.000Z',
        limit: 20,
      });
      assert.equal(fresh.totalMatches, 3);
      assert.deepEqual(
        fresh.messages.map((x) => x.id),
        [uuid(1502), uuid(1500), uuid(1501)],
      );
    },
  );
  await db.close();
  const report = {
    engine: version,
    source:
      'apps/api/src/engagement/mail-query.ts (actual transpiled source; Prisma Sql.text + values executed without alteration)',
    sourceHashes,
    queryCount,
    passed: checks.filter((x) => x.passed).length,
    total: checks.length,
    checks,
  };
  if (process.env.MAIL_QUERY_POSTGRES_REPORT_PATH)
    fs.writeFileSync(
      process.env.MAIL_QUERY_POSTGRES_REPORT_PATH,
      JSON.stringify(report, null, 2) + '\n',
    );
  console.log(JSON.stringify({ passed: report.passed, total: report.total, queryCount }));
  if (report.passed !== report.total) process.exitCode = 1;
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
