const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Actual CLI owner with a finite pg port; this suite never opens a DB connection.
function fixture(options = {}) {
  const calls = [],
    clients = [],
    logs = [];
  class Client {
    constructor(config) {
      this.config = config;
      clients.push(this);
    }
    async connect() {
      calls.push(['connect', this.config.user]);
      if (options.connectFailure === this.config.user)
        throw Error('driver secret=' + this.config.password);
    }
    async end() {
      calls.push(['end', this.config.user]);
      if (options.endFailure === this.config.user)
        throw Error('driver secret=' + this.config.password);
    }
    async query(sql, parameters) {
      calls.push(['query', this.config.user, sql, parameters]);
      if (sql.includes('WHERE rolname = ANY'))
        return {
          rows: options.missingRole
            ? [{ rolname: 'capiro_analytics_ro' }]
            : [{ rolname: 'capiro_analytics_ro' }, { rolname: 'capiro_private_query_ro' }],
        };
      if (sql.startsWith('SELECT 1')) return { rowCount: 1 };
      if (
        sql.startsWith('ALTER ROLE') &&
        options.failPrivate &&
        sql.includes('capiro_private_query_ro')
      )
        throw Error('driver leaked ' + sql);
      if (sql.startsWith('SELECT current_user'))
        return {
          rows: [
            {
              current_user: options.wrongLogin ? 'capiro_app' : this.config.user,
              current_database: this.config.database,
            },
          ],
        };
      return { rows: [], rowCount: 1 };
    }
  }
  const module = { exports: {} };
  const requireMock = (name) =>
    name === 'pg'
      ? { Client }
      : name === 'dotenv'
        ? {
            config() {
              calls.push(['dotenv']);
            },
          }
        : require(name);
  const source = fs.readFileSync(path.join(__dirname, 'bootstrap-roles.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: requireMock,
    process,
    console: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
    },
  });
  const env = {
    DB_HOST: 'synthetic.invalid',
    DB_PORT: '5432',
    DB_NAME: 'capiro',
    MASTER_USER: 'fixture_master',
    MASTER_PASSWORD: 'master-fixture',
    ANALYTICS_USER: 'capiro_analytics_ro',
    ANALYTICS_PASSWORD: "analytics'fixture",
    PRIVATE_QUERY_USER: 'capiro_private_query_ro',
    PRIVATE_QUERY_PASSWORD: 'private-fixture',
    DB_SSL_CA_FILE: path.resolve(__dirname, '../../../infra/cdk/lib/preview/meri-control-ca.pem'),
  };
  return {
    run: (args = ['--run', '--query-readers'], values = env) =>
      module.exports.bootstrapRoles(args, values),
    calls,
    clients,
    logs,
    env,
  };
}
test('query mode rotates only both exact readers atomically and verifies strict-TLS logins after commit', async () => {
  const f = fixture();
  assert.equal(await f.run(), 0);
  assert.deepEqual(
    f.clients.map((c) => c.config.user),
    ['fixture_master', 'capiro_analytics_ro', 'capiro_private_query_ro'],
  );
  for (const { config } of f.clients) {
    assert.equal(config.ssl.rejectUnauthorized, true);
    assert.equal(config.ssl.servername, 'synthetic.invalid');
    assert.ok(config.ssl.ca.includes('BEGIN CERTIFICATE'));
    assert.equal(config.connectionTimeoutMillis, 5000);
  }
  const queries = f.calls.filter((c) => c[0] === 'query').map((c) => c[2]);
  assert.equal(queries.filter((q) => q.startsWith('ALTER ROLE')).length, 2);
  assert.ok(queries.some((q) => q.includes("PASSWORD 'analytics''fixture'")));
  assert.ok(queries.indexOf('COMMIT') < queries.indexOf('SELECT current_user, current_database()'));
  assert.equal(
    f.calls.some((c) => c[0] === 'dotenv'),
    false,
  );
  assert.equal(f.calls.filter((c) => c[0] === 'end').length, 3);
  assert.ok(!f.logs.join('\n').includes("fixture'"));
  for (const secret of [
    f.env.MASTER_PASSWORD,
    f.env.ANALYTICS_PASSWORD,
    f.env.PRIVATE_QUERY_PASSWORD,
  ])
    assert.ok(!f.logs.join('\n').includes(secret));
});
test('query mode rejects half pairs, foreign roles, app/promoter credentials and insecure TLS before connecting', async () => {
  for (const patch of [
    { ANALYTICS_PASSWORD: undefined },
    { PRIVATE_QUERY_USER: undefined },
    { ANALYTICS_USER: 'capiro_app' },
    { PRIVATE_QUERY_USER: 'capiro_analytics_ro' },
    { PRIVATE_QUERY_PASSWORD: '***' },
    { APP_USER: 'capiro_app' },
    { APP_PASSWORD: '' },
    { PROMOTER_PASSWORD: 'secret' },
    { DB_SSL_CA_FILE: undefined },
    { DB_PORT: '5432oops' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ]) {
    const f = fixture();
    await assert.rejects(f.run(undefined, { ...f.env, ...patch }));
    assert.equal(f.clients.length, 0);
  }
});
test('missing role refuses before either password update', async () => {
  const f = fixture({ missingRole: true });
  await assert.rejects(f.run(), /Query role bootstrap failed/);
  assert.equal(
    f.calls.some((c) => c[2]?.startsWith('ALTER ROLE')),
    false,
  );
  assert.equal(f.calls.filter((c) => c[0] === 'end').length, 1);
});
test('second password failure rolls back and sanitizes the password-bearing driver error', async () => {
  const f = fixture({ failPrivate: true });
  await assert.rejects(
    f.run(),
    (error) =>
      error.message === 'Query role bootstrap failed; inspect restricted operator evidence',
  );
  assert.ok(f.calls.some((c) => c[2] === 'ROLLBACK'));
  assert.equal(
    f.calls.some((c) => c[2] === 'COMMIT'),
    false,
  );
  assert.equal(f.clients.length, 1);
  assert.equal(f.calls.at(-1)[0], 'end');
});
test('failed master connection and failed ordinary login both close their clients and sanitize errors', async () => {
  for (const connectFailure of ['fixture_master', 'capiro_private_query_ro']) {
    const f = fixture({ connectFailure });
    await assert.rejects(f.run(), /Query role bootstrap failed/);
    for (const c of f.clients)
      assert.ok(f.calls.some((call) => call[0] === 'end' && call[1] === c.config.user));
  }
});
test('successful transport with wrong effective login refuses', async () => {
  const f = fixture({ wrongLogin: true });
  await assert.rejects(f.run(), /Query role bootstrap failed/);
  assert.equal(f.calls.at(-1)[0], 'end');
});
test('master cleanup failure cannot expose a driver credential error', async () => {
  const f = fixture({ endFailure: 'fixture_master' });
  await assert.rejects(
    f.run(),
    (error) => error.message === 'Query role bootstrap connection cleanup failed',
  );
});
test('legacy app and optional analytics sequence remains alter then verify, with half-pair refusal', async () => {
  const f = fixture();
  const values = { ...f.env, APP_USER: 'capiro_app', APP_PASSWORD: 'app-fixture' };
  assert.equal(await f.run(['--run'], values), 0);
  assert.deepEqual(
    f.clients.map((c) => c.config.user),
    ['fixture_master', 'capiro_app', 'capiro_analytics_ro'],
  );
  const queries = f.calls.filter((c) => c[0] === 'query').map((c) => c[2]);
  assert.ok(
    queries.indexOf('SELECT current_user, current_database()') <
      queries.findIndex((q) => q.includes('ALTER ROLE "capiro_analytics_ro"')),
  );
  assert.equal(queries.includes('BEGIN'), false);
  const half = fixture();
  await assert.rejects(
    half.run(['--run'], { ...values, ANALYTICS_PASSWORD: undefined }),
    /supplied together/,
  );
  assert.equal(half.clients.length, 0);
});
test('help and invalid flags perform no configuration or connection work', async () => {
  for (const [args, exit] of [
    [['--help'], 0],
    [['--run', '--help'], 0],
    [[], 2],
    [['--query-readers'], 2],
    [['--run', '--query-readers', '--extra'], 2],
  ]) {
    const f = fixture();
    assert.equal(await f.run(args, {}), exit);
    assert.equal(f.calls.length, 0);
  }
});
