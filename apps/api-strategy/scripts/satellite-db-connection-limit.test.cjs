const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Run only the actual shell/URL code. Every application, Prisma, task and CA
// invocation is recorded by a dummy node command; no product module is loaded.
const root = path.resolve(__dirname, '../../..');
const services = ['api-strategy', 'intel-api'];
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/sh.exe' : '/bin/sh';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'satellite-pool-offline-'));
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin);
const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
const guard = path.join(scratch, 'network-guard.cjs');
fs.writeFileSync(guard, `
const deny = () => { throw Error('OFFLINE_NETWORK_FORBIDDEN'); };
for (const [name, methods] of Object.entries({net:['connect','createConnection','createServer'],tls:['connect','createServer'],http:['request','get'],https:['request','get'],dns:['lookup','resolve'],dgram:['createSocket']}))
  for (const method of methods) require('node:'+name)[method] = deny;
require('node:net').Socket.prototype.connect = deny; global.fetch = deny;
`);
const stub = path.join(scratch, 'node-stub.cjs');
fs.writeFileSync(stub, `
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2), env=process.env;
const record=value=>fs.appendFileSync(env.POOL_TEST_TRACE,JSON.stringify(value)+'\\n');
record({kind:'invocation',args});
if (!args.length || (args[0]==='-e' && args[1].startsWith('process.stdout.write(encodeURIComponent('))) {
  const result=cp.spawnSync(process.execPath,args,{env,input:args.length?undefined:fs.readFileSync(0),encoding:'utf8'});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);
}
if (args[0]==='/app/apps/api/scripts/lib/meri-control-ca.cjs') {
  record({kind:'ca'});process.stdout.write(env.POOL_TEST_CA);process.exit(Number(env.POOL_TEST_CA_EXIT||0));
}
record({kind:'application',args,url:env.DATABASE_URL,tmpdir:env.POOL_TEST_OBSERVED_TMPDIR,ca:env.NODE_EXTRA_CA_CERTS});
process.exit(args.includes('migrate')?Number(env.POOL_TEST_MIGRATION_EXIT||0):0);
`);
// TMPDIR is specially rewritten by MSYS for native Windows children even with
// conversion disabled. Capture the shell's value before that platform shim.
fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexport POOL_TEST_OBSERVED_TMPDIR="$TMPDIR"\nexec ' + quote(process.execPath) + ' ' + quote(stub) + ' "$@"\n', { mode: 0o755 });
let sequence = 0;
const rawUrl = 'postgresql://DO_NOT_LOG_user:DO_NOT_LOG%40pass@db.example.invalid:5432/dummy_db';
const parts = { DB_HOST: 'db.example.invalid', DB_PORT: '5432', DB_USER: 'dummy_user', DB_PASSWORD: 'DO_NOT_LOG $:@/?#% é', DB_NAME: 'dummy_db' };
function run(service, values = {}, args = ['serve']) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'TEMP', 'TMP', 'COMSPEC', 'ComSpec', 'PATHEXT'])
    if (process.env[name]) env[name] = process.env[name];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = bin + path.delimiter + (env[pathKey] || '');
  env.POOL_TEST_TRACE = path.join(scratch, 'trace-' + (++sequence) + '.jsonl');
  // Git for Windows otherwise rewrites POSIX argv/env values for node.exe.
  env.MSYS_NO_PATHCONV = '1';
  env.MSYS2_ARG_CONV_EXCL = '*';
  env.MSYS2_ENV_CONV_EXCL = '*';
  env.POOL_TEST_CA = path.join(scratch, 'dummy-public-ca.pem');
  env.NODE_OPTIONS = '--require=' + JSON.stringify(guard);
  Object.assign(env, values);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const result = spawnSync(shell, [path.join(root, 'apps', service, 'scripts/entrypoint.sh'), ...args], {
    cwd: scratch, env, encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  const events = fs.existsSync(env.POOL_TEST_TRACE)
    ? fs.readFileSync(env.POOL_TEST_TRACE, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const applications = events.filter(event => event.kind === 'application');
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_LOG|postgres(?:ql)?:\/\//, 'No URL or dummy secret in logs/errors');
  for (const event of events.filter(event => event.kind === 'invocation'))
    assert.doesNotMatch(JSON.stringify(event.args), /DO_NOT_LOG|postgres(?:ql)?:\/\//, 'No URL or dummy secret in argv');
  return { ...result, events, applications, ca: env.POOL_TEST_CA };
}
function admitted(service, values, expectedUrl) {
  const result = run(service, values);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].url, expectedUrl);
  assert.deepEqual(result.applications[0].args, ['dist/main.js']);
  return result;
}
function refused(service, values) {
  const result = run(service, values);
  assert.notEqual(result.status, 0);
  assert.equal(result.applications.length, 0, 'Invalid input must fail before any application/migration');
  assert.match(result.stderr, /Invalid database pool configuration/);
}

for (const service of services) {
  test(service + ': unset leaves supplied URL byte-identical, even an existing noncanonical limit', () => {
    const url = rawUrl + '?sslmode=verify-full&schema=custom&connection_limit=0007';
    const result = admitted(service, { DATABASE_URL: url }, url);
    assert.equal(result.events.filter(event => event.kind === 'invocation').length, 1);
  });
  test(service + ': unset retains legacy DB_* composition and password escaping without secret argv', () => {
    admitted(service, parts, 'postgresql://dummy_user:' + encodeURIComponent(parts.DB_PASSWORD) + '@db.example.invalid:5432/dummy_db?schema=public&sslmode=require');
  });
  test(service + ': explicit limit encodes composed credentials/database and preserves TLS', () => {
    const values = { ...parts, DB_CONNECTION_LIMIT: '10', DB_USER: 'DO_NOT_LOG user:@/é', DB_NAME: 'db /?#é' };
    admitted(service, values, 'postgresql://' + encodeURIComponent(values.DB_USER) + ':' + encodeURIComponent(values.DB_PASSWORD) + '@db.example.invalid:5432/' + encodeURIComponent(values.DB_NAME) + '?schema=public&sslmode=require&connection_limit=10');
  });
  test(service + ': composed IPv6 host is preserved', () => {
    for (const host of ['::1', '[::1]']) admitted(service, { ...parts, DB_HOST: host, DB_CONNECTION_LIMIT: '10' }, 'postgresql://dummy_user:' + encodeURIComponent(parts.DB_PASSWORD) + '@[::1]:5432/dummy_db?schema=public&sslmode=require&connection_limit=10');
  });
  test(service + ': supplied URL wins over DB_* and preserves exact TLS/query bytes', () => {
    const url = rawUrl + '?sslmode=verify-full&sslrootcert=%2Fcerts%2Fdb%20ca.pem&schema=Custom%20Schema&options=a+b&application_name=%E2%9C%93';
    admitted(service, { ...parts, DB_HOST: 'unused.example.invalid', DATABASE_URL: url, DB_CONNECTION_LIMIT: '10' }, url + '&connection_limit=10');
  });
  test(service + ': appends correctly to absent/empty/trailing query, postgres alias and IPv6 URLs', () => {
    for (const [url, suffix] of [[rawUrl, '?'], [rawUrl + '?', ''], [rawUrl + '?sslmode=require&', ''], ['postgres://dummy:DO_NOT_LOG@[::1]:5432/db?sslmode=require', '&']])
      admitted(service, { DATABASE_URL: url, DB_CONNECTION_LIMIT: '10' }, url + suffix + 'connection_limit=10');
  });
  test(service + ': matching existing encoded key/value stays byte-identical', () => {
    for (const query of ['connection_limit=10', '%63onnection_limit=%31%30']) {
      const url = rawUrl + '?' + query + '&sslmode=require';
      admitted(service, { DATABASE_URL: url, DB_CONNECTION_LIMIT: '10' }, url);
    }
  });
  test(service + ': positive integer boundaries are exact', () => {
    for (const limit of ['1', '2147483647']) admitted(service, { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: limit }, rawUrl + '?connection_limit=' + limit);
  });
  test(service + ': rejects empty/noncanonical/negative/fractional/exponent/overflow/whitespace/injected limits', () => {
    for (const limit of ['', '0', '-1', '+10', '01', '1.5', '1e1', '2147483648', '99999999999999999999999', ' 10', '10 ', '10\n', '10&sslmode=disable', 'DO_NOT_LOG'])
      refused(service, { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: limit });
  });
  test(service + ': refuses malformed, conflicting and duplicate URL limits', () => {
    for (const query of ['connection_limit=11', 'connection_limit=', 'connection_limit=0', 'connection_limit=01', 'connection_limit=1.0', 'connection_limit=%2010', 'connection_limit=10&connection_limit=10', 'connection_limit=10&%63onnection_limit=11', 'connection_limit=%ZZ'])
      refused(service, { DATABASE_URL: rawUrl + '?' + query, DB_CONNECTION_LIMIT: '10' });
  });
  test(service + ': rejects malformed URLs without leaking their value', () => {
    for (const url of ['DO_NOT_LOG', 'https://DO_NOT_LOG@example.invalid/db', rawUrl + '#DO_NOT_LOG', rawUrl + '#', ' ' + rawUrl, rawUrl + '\n', rawUrl.replace('/dummy_db', '/'), rawUrl + '?sslrootcert=%ZZ', rawUrl + '\\DO_NOT_LOG'])
      refused(service, { DATABASE_URL: url, DB_CONNECTION_LIMIT: '10' });
  });
  test(service + ': rejects missing or malformed composed target fields', () => {
    for (const field of Object.keys(parts)) refused(service, { ...parts, [field]: '', DB_CONNECTION_LIMIT: '10' });
    for (const port of ['0', '65536', '5432?sslmode=disable', '05432']) refused(service, { ...parts, DB_PORT: port, DB_CONNECTION_LIMIT: '10' });
    for (const host of ['db/DO_NOT_LOG', 'db@DO_NOT_LOG', 'db?sslmode=disable', 'db DO_NOT_LOG', 'db:1234']) refused(service, { ...parts, DB_HOST: host, DB_CONNECTION_LIMIT: '10' });
  });
  test(service + ': unset missing-field errors do not print target or credential values', () => {
    const result = run(service, { ...parts, DB_HOST: 'DO_NOT_LOG', DB_NAME: '' });
    assert.notEqual(result.status, 0); assert.equal(result.applications.length, 0);
    assert.match(result.stderr, /Missing required DB_\* env vars/);
  });
  test(service + ': default mode and TMPDIR behavior are preserved', () => {
    const result = run(service, { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: '10' }, []);
    assert.equal(result.status, 0); assert.deepEqual(result.applications[0].args, ['dist/main.js']);
    assert.equal(result.applications[0].tmpdir, '/dev/shm');
    const custom = admitted(service, { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: '10', TMPDIR: '/app/dummy-tmp' }, rawUrl + '?connection_limit=10');
    assert.equal(custom.applications[0].tmpdir, '/app/dummy-tmp');
  });
  test(service + ': unknown modes still refuse without application startup', () => {
    const result = run(service, { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: '10' }, ['unknown-mode']);
    assert.notEqual(result.status, 0); assert.equal(result.applications.length, 0);
    assert.match(result.stderr, /Unknown command/);
  });
}

const modes = {
  'api-strategy': [
    [['migrate'], [['node_modules/prisma/build/index.js', 'migrate', 'deploy'], ['dist/seed.js', '--run']]],
    [['seed'], [['dist/seed.js', '--run']]],
    [['update-strategy-reference'], [['dist/reference-ops.js']]],
  ],
  'intel-api': [
    [['migrate'], [['node_modules/prisma/build/index.js', 'migrate', 'deploy']]],
    [['public-capture-preflight', '--limit=2'], [['dist/hearing/capture/public-capture-task-runner.js', 'preflight', '--limit=2']]],
    [['public-capture-worker', '--limit=2'], [['dist/hearing/capture/public-capture-task-runner.js', 'worker', '--limit=2']]],
    [['public-capture-status'], [['dist/hearing/capture/public-capture-task-runner.js', 'status']]],
    [['hearing-media', 'space arg'], [['dist/hearing/recording/run-hearing-media.js', 'space arg']]],
    [['hearing-delivery', 'space arg'], [['dist/hearing/run-hearing-delivery.js', 'space arg']]],
    [['legiwatch-phase9-capture', '--limit=2'], [['dist/hearing/capture/run-phase9-public-capture.js', '--limit=2']]],
    [['legiwatch-phase9-intelligence', '--limit=2'], [['dist/hearing/intelligence/run-phase9-hearing-intelligence.js', '--limit=2']]],
    [['task', 'hearing-stream-preflight', '--limit=2'], [['dist/hearing/capture/public-capture-task-runner.js', 'preflight', '--limit=2']]],
    [['task', 'hearing-capture-worker', '--limit=2'], [['dist/hearing/capture/public-capture-task-runner.js', 'worker', '--limit=2']]],
    [['task', 'dummy-task', 'space arg'], [['dist/tasks/task-runner.js', 'dummy-task', 'space arg']]],
  ],
};
for (const [service, cases] of Object.entries(modes)) for (const [args, expected] of cases)
  test(service + ': delegates ' + args.join(' ') + ' unchanged', () => {
    for (const limit of [undefined, '10']) {
      const result = run(service, { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: limit }, args);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.applications.map(call => call.args), expected);
      for (const call of result.applications) assert.equal(call.url, rawUrl + (limit ? '?connection_limit=10' : ''));
    }
  });
for (const service of services) test(service + ': migrate failure propagates and never advances to seed', () => {
  const result = run(service, { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: '10', POOL_TEST_MIGRATION_EXIT: '7' }, ['migrate']);
  assert.equal(result.status, 7); assert.equal(result.applications.length, 1);
});
test('Intel enable-feature retains its existing inline command and does not execute it in this test', () => {
  const result = run('intel-api', { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: '10' }, ['enable-feature', 'dummy-feature', 'dummy-tenant']);
  assert.equal(result.status, 0); assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].args[0], '-e');
  assert.match(result.applications[0].args[1], /dummy-feature/);
  assert.match(result.applications[0].args[1], /dummy-tenant/);
});
test('Strategy CA validation remains before application and preserves its returned certificate path', () => {
  const result = run('api-strategy', { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: '10', MERI_CONTROL_ORIGIN: 'https://dummy.example.invalid' });
  assert.equal(result.status, 0); assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].ca, result.ca);
  assert.ok(result.events.findIndex(e => e.kind === 'ca') < result.events.findIndex(e => e.kind === 'application'));
  const denied = run('api-strategy', { DATABASE_URL: rawUrl, DB_CONNECTION_LIMIT: '10', MERI_CONTROL_CA_SHA256: 'dummy', POOL_TEST_CA_EXIT: '9' });
  assert.equal(denied.status, 9); assert.equal(denied.applications.length, 0);
});
test('Both entrypoints use identical optional URL validation; existing images copy them and retain dumb-init', () => {
  const sources = services.map(service => fs.readFileSync(path.join(root, 'apps', service, 'scripts/entrypoint.sh'), 'utf8'));
  assert.equal(sources[0].split("<<'NODE'\n")[1].split('\nNODE')[0], sources[1].split("<<'NODE'\n")[1].split('\nNODE')[0]);
  for (const service of services) for (const dockerfile of ['Dockerfile', 'Dockerfile.alpine']) {
    const source = fs.readFileSync(path.join(root, 'apps', service, dockerfile), 'utf8');
    assert.ok(source.includes('apps/' + service + '/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh'));
    assert.ok(source.includes('ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]'));
  }
});

test.after(() => {
  const resolved = fs.realpathSync(scratch);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);
  assert.ok(relative.startsWith('satellite-pool-offline-') && !relative.includes(path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});
