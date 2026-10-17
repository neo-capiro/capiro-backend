import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECTIVE_PLANNER_NATIVE_OWNER, ObjectivePlannerNativeTargetError,
  objectivePlannerNativeOptIn, objectivePlannerNativeTarget,
  requireObjectivePlannerNativePostmaster, requireObjectivePlannerNativeCatalog,
} from './objective-planner-native-target.ts';

const nowMs = Date.parse('2026-10-17T00:00:00.000Z');
function fixture() {
  const context = { workspaceRoot: 'C:\\tasks\\objective-planner', sourceHead: 'a'.repeat(40), nowMs };
  const env = { OBJECTIVE_PLANNER_NATIVE_OPT_IN: '1', CI_DISPOSABLE_POSTGRES: '1',
    OBJECTIVE_PLANNER_NATIVE_DATABASE_URL: 'postgresql://capiro_app:test-only-password@127.0.0.1:55473/planner_qa' };
  const manifest = { schemaVersion: 1, kind: 'task-owned-objective-planner-postgres',
    owner: OBJECTIVE_PLANNER_NATIVE_OWNER, sourceHead: context.sourceHead,
    workspaceRoot: context.workspaceRoot, dataDirectory: `${context.workspaceRoot}\\.objective-planner-native\\postgres-data`,
    hostname: '127.0.0.1', port: 55473, database: 'planner_qa', databaseOid: 16401,
    runtimeRole: 'capiro_app', processId: 1720, postmasterStartedAtSeconds: nowMs / 1000 - 60,
    ownershipToken: 'b'.repeat(64), createdAt: new Date(nowMs - 30_000).toISOString(),
    expiresAt: new Date(nowMs + 3_600_000).toISOString() };
  return { env, manifest, context };
}
const target = f => objectivePlannerNativeTarget(f.env, f.manifest, f.context);
const refused = run => assert.throws(run, e => e instanceof ObjectivePlannerNativeTargetError);
const postmaster = m => ({ workspaceRealPath: m.workspaceRoot, dataDirectoryRealPath: m.dataDirectory,
  pgVersion: '16\n', processAlive: true,
  postmasterPid: `${m.processId}\n${m.dataDirectory}\n${m.postmasterStartedAtSeconds}\n${m.port}\n\n127.0.0.1,::1\nready\n` });
const catalog = m => ({ databaseName: m.database, databaseOid: m.databaseOid, roleName: m.runtimeRole,
  serverPort: m.port, databaseComment: `task-owned:objective-planner-native:${m.ownershipToken}`,
  postmasterStartedAtSeconds: String(m.postmasterStartedAtSeconds), superuser: false, bypassRls: false });

test('default-off guard returns before inspecting manifest or unrelated DB configuration', () => {
  const f = fixture(); delete f.env.OBJECTIVE_PLANNER_NATIVE_OPT_IN;
  f.env.DATABASE_URL = 'postgresql://unrelated.example/production';
  let touched = 0;
  const manifest = new Proxy({}, { ownKeys() { touched++; throw Error('must remain inert'); } });
  assert.equal(objectivePlannerNativeOptIn(f.env), false);
  assert.deepEqual(objectivePlannerNativeTarget(f.env, manifest, f.context), { enabled: false });
  assert.equal(touched, 0);
});
test('explicit owned loopback target returns frozen ownership and preserves exact dedicated URL', () => {
  const f = fixture(), t = target(f);
  assert.equal(t.enabled, true); assert.equal(t.databaseUrl, f.env.OBJECTIVE_PLANNER_NATIVE_DATABASE_URL);
  assert.deepEqual(t.manifest, f.manifest); assert.ok(Object.isFrozen(t.manifest));
  requireObjectivePlannerNativePostmaster(t, postmaster(f.manifest));
  requireObjectivePlannerNativeCatalog(t, catalog(f.manifest));
});
test('localhost is allowed only when exact manifest host agrees', () => {
  const f = fixture(); f.env.OBJECTIVE_PLANNER_NATIVE_DATABASE_URL = f.env.OBJECTIVE_PLANNER_NATIVE_DATABASE_URL.replace('127.0.0.1', 'localhost');
  refused(() => target(f)); f.manifest.hostname = 'localhost'; assert.equal(target(f).enabled, true);
});
for (const optIn of ['0', 'true', 'yes', '', ' 1', '1 ']) {
  test(`explicit opt-in value ${JSON.stringify(optIn)} is refused`, () => {
    const f = fixture(); f.env.OBJECTIVE_PLANNER_NATIVE_OPT_IN = optIn; refused(() => target(f));
  });
}
for (const key of ['CI_DISPOSABLE_POSTGRES', 'OBJECTIVE_PLANNER_NATIVE_DATABASE_URL']) {
  test(`enabled qualification requires ${key}`, () => {
    const f = fixture(); delete f.env[key]; refused(() => target(f));
  });
}
for (const key of ['DATABASE_URL', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  test(`enabled qualification rejects inherited ${key}`, () => {
    const f = fixture(); f.env[key] = ''; refused(() => target(f));
  });
}
for (const url of [
  'postgresql://capiro_app:secret@127.0.0.1:5432/planner_qa',
  'postgresql://capiro_app:secret@127.0.0.1/planner_qa',
  'postgresql://capiro_app:secret@127.0.0.1:55473/capiro',
  'postgresql://capiro_app:secret@127.0.0.1:55473/planner_qa?schema=public',
  'postgresql://capiro_app:secret@127.0.0.1:55473/planner_qa#fragment',
  'postgresql://capiro_app:secret@remote.example:55473/planner_qa',
  'postgresql://capiro_app:secret@127.0.0.2:55473/planner_qa',
  'postgresql://capiro_app:secret@localhost.:55473/planner_qa',
  'postgresql://capiro_app:secret@[::1]:55473/planner_qa',
  'postgresql://capiro_app:secret@127.0.0.1:1023/planner_qa',
  'postgresql://capiro_app@127.0.0.1:55473/planner_qa',
  'postgresql://:secret@127.0.0.1:55473/planner_qa',
  'https://capiro_app:secret@127.0.0.1:55473/planner_qa',
  'not-a-url',
]) {
  test(`dedicated URL rejects unsafe identity variant ${url.replace(/:secret@/, ':<redacted>@')}`, () => {
    const f = fixture(); f.env.OBJECTIVE_PLANNER_NATIVE_DATABASE_URL = url;
    refused(() => target(f));
    try { target(f); } catch (error) { assert.ok(!error.message.includes('secret')); }
  });
}
for (const [key, value] of Object.entries({ schemaVersion: 2, kind: 'shared-postgres', owner: 'someone-else',
  sourceHead: 'c'.repeat(40), workspaceRoot: 'C:\\tasks\\other', dataDirectory: 'C:\\Program Files\\PostgreSQL\\16\\data',
  hostname: 'localhost', port: 55474, database: 'capiro', databaseOid: 0, runtimeRole: 'postgres', processId: 0,
  postmasterStartedAtSeconds: nowMs / 1000 + 1, ownershipToken: 'short',
  createdAt: new Date(nowMs + 1).toISOString(), expiresAt: new Date(nowMs).toISOString() })) {
  test(`ownership requires exact bounded ${key}`, () => {
    const f = fixture(); f.manifest[key] = value; refused(() => target(f));
  });
}
test('manifest validity is bounded to at most 24 hours and canonical timestamps', () => {
  const f = fixture(); f.manifest.expiresAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(); refused(() => target(f));
  const g = fixture(); g.manifest.createdAt = '2026-10-16T23:59:30Z'; refused(() => target(g));
});
test('ownership directory must be exact task-local data path; sibling-prefix and symlink observations refuse', () => {
  const f = fixture(); f.manifest.dataDirectory += '-other'; refused(() => target(f));
  const g = fixture(), t = target(g), p = postmaster(g.manifest);
  p.dataDirectoryRealPath = 'C:\\Program Files\\PostgreSQL\\16\\data';
  refused(() => requireObjectivePlannerNativePostmaster(t, p));
});
test('manifest is closed JSON; getters and proxies are refused without invocation', () => {
  for (const kind of ['extra', 'missing', 'getter', 'proxy']) {
    const f = fixture(); let touched = 0;
    if (kind === 'extra') f.manifest.extra = true;
    if (kind === 'missing') delete f.manifest.processId;
    if (kind === 'getter') Object.defineProperty(f.manifest, 'processId', { enumerable: true, get() { touched++; throw Error('getter'); } });
    if (kind === 'proxy') f.manifest = new Proxy(f.manifest, { ownKeys() { touched++; throw Error('proxy'); } });
    refused(() => target(f)); assert.equal(touched, 0);
  }
});
for (const [key, value] of Object.entries({ pgVersion: '15\n', processAlive: false, workspaceRealPath: 'C:\\elsewhere',
  postmasterPid: '1720\nC:\\external\\data\n1\n5432\n\n*\nready\n' })) {
  test(`actual postmaster ${key} mismatch refuses before Prisma construction`, () => {
    const f = fixture(), p = postmaster(f.manifest); p[key] = value;
    refused(() => requireObjectivePlannerNativePostmaster(target(f), p));
  });
}
test('postmaster PID, start instant, port and listeners are checked independently', () => {
  for (const [line, value] of [[0, '1721'], [2, '1'], [3, '55474'], [5, '*'], [5, '127.0.0.1,10.0.0.1'], [5, '']]) {
    const f = fixture(), p = postmaster(f.manifest), lines = p.postmasterPid.split('\n');
    lines[line] = value; p.postmasterPid = lines.join('\n');
    refused(() => requireObjectivePlannerNativePostmaster(target(f), p));
  }
});
for (const [key, value] of Object.entries({ databaseName: 'capiro', databaseOid: 16402, roleName: 'postgres',
  serverPort: 5432, databaseComment: null, postmasterStartedAtSeconds: '1', superuser: true, bypassRls: true })) {
  test(`connected catalog ${key} mismatch refuses before fixture effects`, () => {
    const f = fixture(), c = catalog(f.manifest); c[key] = value;
    refused(() => requireObjectivePlannerNativeCatalog(target(f), c));
  });
}
