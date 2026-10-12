'use strict';

/**
 * jest.worker-database-controls.cjs  (CleanUp1 api643)
 *
 * Bounded, pure source-level controls for `jest.worker-database.cjs`. They
 * `require()` the REAL committed helper and exercise its exported pure mapping
 * helper with synthetic env objects. NO Docker, Git, Postgres, network,
 * subprocess or child process is spawned, no database is opened and no native
 * work is done. Passing these does NOT accept C1, prove a native run, or stand
 * in for any native test result.
 *
 * The helper's require-time SIDE EFFECT (disabled no-op vs. a real enabled fork
 * binding its clone) is exercised only for the disabled no-op here; the enabled
 * fork binding is proven natively by the full API driver.
 *
 * Run (root, after review):  node apps/api/jest.worker-database-controls.cjs
 */

const path = require('node:path');

// Force the disabled state BEFORE requiring the real helper so that requiring it
// in this control process is a strict no-op regardless of ambient env.
for (const name of [
  'CLEANUP_API_WORKER_DB',
  'CLEANUP_API_WORKER_DB_TOKEN',
  'CLEANUP_API_WORKER_DB_MAP',
  'CLEANUP_API_WORKER_DB_EVIDENCE_DIR',
  'CLEANUP_API_WORKER_DB_VERBOSE',
]) {
  delete process.env[name];
}

const HELPER = require(path.join(__dirname, 'jest.worker-database.cjs'));

const ENABLED_ENV = HELPER.ENABLED_ENV;
const TOKEN_ENV = HELPER.TOKEN_ENV;
const MAP_ENV = HELPER.MAP_ENV;
const TOKEN = HELPER.TOKEN;

const CAPiro = 'postgresql://postgres:***@127.0.0.1:5432/capiro?schema=public';
const FO = 'postgresql://fo_test:***@127.0.0.1:5486/fo_v2_test?schema=public';

const results = [];

function check(name, condition, detail) {
  results.push({ control: name, ok: Boolean(condition), detail: detail === undefined ? null : detail });
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof Error;
  }
}

function enabledEnv(workerId, extra) {
  return Object.assign(
    { [ENABLED_ENV]: '1', JEST_WORKER_ID: workerId, [TOKEN_ENV]: TOKEN, DATABASE_URL: CAPiro },
    extra || {},
  );
}

// --- disabled / no-worker are strict no-ops --------------------------------
const disabled = HELPER.resolveWorkerDatabase({ DATABASE_URL: CAPiro });
check('disabled (no flag) is a no-op', disabled.enabled === false && disabled.applied === false);
check('disabled preserves the inherited DATABASE_URL unchanged', disabled.databaseUrl === CAPiro);
check('disabled never inspects/validates the base URL', !throws(() => HELPER.resolveWorkerDatabase({ DATABASE_URL: 'not a url' })));
const noWorker = HELPER.resolveWorkerDatabase({ [ENABLED_ENV]: '1', DATABASE_URL: CAPiro });
check('enabled with no JEST_WORKER_ID is a master/no-worker no-op',
  noWorker.applied === false && noWorker.workerId === null && noWorker.reason === 'no-worker/master');
const emptyWorker = HELPER.resolveWorkerDatabase({ [ENABLED_ENV]: '1', JEST_WORKER_ID: '', DATABASE_URL: CAPiro });
check('enabled with blank worker id is a no-op', emptyWorker.applied === false);

// --- each worker binds its OWN clone from an approved base ------------------
const w1 = HELPER.resolveWorkerDatabase(enabledEnv('1'));
const w2 = HELPER.resolveWorkerDatabase(enabledEnv('2'));
check('worker 1 binds capiro_worker_1',
  w1.applied === true && w1.workerId === '1' && w1.database === 'capiro_worker_1' && w1.reason === 'bound');
check('worker 2 binds capiro_worker_2',
  w2.applied === true && w2.workerId === '2' && w2.database === 'capiro_worker_2');
check('the two workers map to DISTINCT databases', w1.database !== w2.database && w1.databaseUrl !== w2.databaseUrl);
check('fo_v2_test base also splits into its clones',
  HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: FO })).database === 'fo_v2_test_worker_1' &&
  HELPER.resolveWorkerDatabase(enabledEnv('2', { DATABASE_URL: FO })).database === 'fo_v2_test_worker_2');
check('mapping helper agrees with the bound result',
  HELPER.workerDatabaseForId('1', 'capiro') === 'capiro_worker_1' &&
  HELPER.workerDatabaseForId('2', 'fo_v2_test') === 'fo_v2_test_worker_2' &&
  HELPER.workerDatabaseForId('3', 'capiro') === null &&
  HELPER.workerDatabaseForId('1', 'not_a_base') === null);

// --- host / port / role / query retained ------------------------------------
check('worker 1 URL keeps role, host, port and query string',
  w1.databaseUrl.startsWith('postgresql://') && w1.databaseUrl.includes('@127.0.0.1') &&
  w1.databaseUrl.includes(':5432') && w1.databaseUrl.includes('?schema=public') &&
  w1.databaseUrl.endsWith('/capiro_worker_1?schema=public'));
check('only the database segment changed vs the inherited default',
  (() => {
    const before = new URL(CAPiro);
    const after = new URL(w1.databaseUrl);
    return after.host === before.host && after.username === before.username &&
      after.password === before.password && after.search === before.search &&
      before.pathname === '/capiro' && after.pathname === '/capiro_worker_1';
  })());

// --- already-bound real fork is accepted idempotently -----------------------
const already = HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: w1.databaseUrl }));
check('same-worker already-bound binding is idempotent',
  already.applied === false && already.reason === 'already-bound' && already.databaseUrl === w1.databaseUrl);
const alreadyNoMap = HELPER.resolveWorkerDatabase({ [ENABLED_ENV]: '1', JEST_WORKER_ID: '2', [TOKEN_ENV]: TOKEN, DATABASE_URL: 'postgresql://postgres:***@127.0.0.1:5432/capiro_worker_2?schema=public' });
check('already-bound fork with no explicit map is recognized',
  alreadyNoMap.applied === false && alreadyNoMap.reason === 'already-bound' && alreadyNoMap.database === 'capiro_worker_2');

// --- explicit mapping -------------------------------------------------------
const MAP = JSON.stringify({ '1': 'capiro_worker_1', '2': 'capiro_worker_2' });
check('explicit mapping binds the declared clone',
  HELPER.resolveWorkerDatabase(enabledEnv('1', { [MAP_ENV]: MAP })).database === 'capiro_worker_1');
check('explicit mapping already-bound is idempotent',
  HELPER.resolveWorkerDatabase(enabledEnv('2', { [MAP_ENV]: MAP, DATABASE_URL: 'postgresql://postgres:***@127.0.0.1:5432/capiro_worker_2' })).reason === 'already-bound');
check('malformed (non-JSON) mapping fails closed',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { [MAP_ENV]: '{not json' }))));
check('mapping with wrong keys fails closed',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { [MAP_ENV]: JSON.stringify({ '1': 'capiro_worker_1' }) }))));
check('mapping with a non-identifier target fails closed',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { [MAP_ENV]: JSON.stringify({ '1': 'bad-name!', '2': 'capiro_worker_2' }) }))));
check('mapping that swaps the current worker fails closed',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', {
    [MAP_ENV]: MAP, DATABASE_URL: 'postgresql://postgres:***@127.0.0.1:5432/capiro_worker_2' }))));

// --- explicit map must be the CANONICAL exact targets for the selected base --
// Root's three independent map probes: swapped, arbitrary safe-identifier and
// cross-base destinations are all refused BEFORE any rebinding.
check('explicit map with the two workers SWAPPED fails closed',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', {
    [MAP_ENV]: JSON.stringify({ '1': 'capiro_worker_2', '2': 'capiro_worker_1' }) }))));
check('explicit map with arbitrary safe-identifier destinations (foreign_db/other_db) fails closed',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', {
    [MAP_ENV]: JSON.stringify({ '1': 'foreign_db', '2': 'other_db' }) }))));
check('explicit map crossing capiro -> fo_v2_test clones fails closed',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', {
    [MAP_ENV]: JSON.stringify({ '1': 'fo_v2_test_worker_1', '2': 'fo_v2_test_worker_2' }) }))));
check('cross-base explicit map against an already-bound base fails closed',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('2', {
    [MAP_ENV]: MAP, DATABASE_URL: 'postgresql://postgres:***@127.0.0.1:5432/fo_v2_test_worker_2' }))));
check('the canonical explicit map for the fo_v2_test base binds its clones',
  HELPER.resolveWorkerDatabase(enabledEnv('1', {
    [MAP_ENV]: JSON.stringify({ '1': 'fo_v2_test_worker_1', '2': 'fo_v2_test_worker_2' }),
    DATABASE_URL: FO })).database === 'fo_v2_test_worker_1');

// --- IPv6 loopback (real Node hostname '[::1]') is accepted -------------------
const ipv6 = HELPER.resolveWorkerDatabase(enabledEnv('1', {
  DATABASE_URL: 'postgresql://postgres:***@[::1]:5432/capiro?schema=public' }));
check('IPv6 loopback ([::1]) is accepted and binds worker 1',
  ipv6.applied === true && ipv6.database === 'capiro_worker_1'
  && ipv6.databaseUrl.includes('[::1]') && ipv6.databaseUrl.includes(':5432')
  && ipv6.databaseUrl.includes('?schema=public'));
check('a non-loopback IPv6 literal host is still rejected',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', {
    DATABASE_URL: 'postgresql://postgres:***@[2001:db8::1]:5432/capiro' }))));

// --- fail-closed rejections --------------------------------------------------
check('swapped/wrong-worker clone is rejected (no explicit map)',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: w2.databaseUrl }))));
check('unknown worker id is rejected', throws(() => HELPER.resolveWorkerDatabase(enabledEnv('3'))));
check('non-numeric worker id is rejected', throws(() => HELPER.resolveWorkerDatabase(enabledEnv('worker_1'))));
check('missing token is rejected',
  throws(() => HELPER.resolveWorkerDatabase({ [ENABLED_ENV]: '1', JEST_WORKER_ID: '1', DATABASE_URL: CAPiro })));
check('wrong token is rejected',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { [TOKEN_ENV]: TOKEN + '-wrong' }))));
check('missing DATABASE_URL is rejected',
  throws(() => HELPER.resolveWorkerDatabase({ [ENABLED_ENV]: '1', JEST_WORKER_ID: '1', [TOKEN_ENV]: TOKEN })));
check('blank DATABASE_URL is rejected',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: '   ' }))));
check('non-postgres scheme is rejected',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: 'mysql://postgres:***@127.0.0.1:5432/capiro' }))));
check('non-loopback host is rejected',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: 'postgresql://postgres:***@db.example.com:5432/capiro' }))));
check('unknown base database is rejected',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: 'postgresql://postgres:***@127.0.0.1:5432/some_other_db' }))));
check('invalid URL is rejected',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: 'not a url' }))));
check('URL with no database name is rejected',
  throws(() => HELPER.resolveWorkerDatabase(enabledEnv('1', { DATABASE_URL: 'postgresql://postgres:***@127.0.0.1:5432/' }))));

// --- dedicated *_TEST_DATABASE_URL envs are untouched ------------------------
const dedicated = enabledEnv('1', {
  MERGE_TEST_DATABASE_URL: 'postgresql://postgres:***@127.0.0.1:5432/capiro_merge_test?schema=public',
  PEOPLE_TEST_DATABASE_URL: 'postgresql://postgres:***@127.0.0.1:5432/capiro_people_test?schema=public',
});
const dedicatedCopy = JSON.parse(JSON.stringify(dedicated));
const dedicatedOut = HELPER.resolveWorkerDatabase(dedicated);
check('dedicated *_TEST_DATABASE_URL variables are never modified',
  dedicated.MERGE_TEST_DATABASE_URL === dedicatedCopy.MERGE_TEST_DATABASE_URL &&
  dedicated.PEOPLE_TEST_DATABASE_URL === dedicatedCopy.PEOPLE_TEST_DATABASE_URL);
check('the pure helper does not mutate its input env object',
  JSON.stringify(dedicated) === JSON.stringify(dedicatedCopy));
check('bound URL never leaks a dedicated env database',
  dedicatedOut.applied === true && !dedicatedOut.databaseUrl.includes('merge_test') &&
  !dedicatedOut.databaseUrl.includes('people_test'));

// --- module surface + control-process isolation ------------------------------
check('helper exports the pure helpers and their pinned constants',
  typeof HELPER.resolveWorkerDatabase === 'function' &&
  typeof HELPER.workerDatabaseForId === 'function' &&
  typeof HELPER.defaultWorkerMap === 'function' &&
  HELPER.ENABLED_ENV === 'CLEANUP_API_WORKER_DB' &&
  HELPER.TOKEN_ENV === 'CLEANUP_API_WORKER_DB_TOKEN' &&
  HELPER.TOKEN === 'cleanup-api-worker-db-v1' &&
  HELPER.MAP_ENV === 'CLEANUP_API_WORKER_DB_MAP' &&
  HELPER.EVIDENCE_ENV === 'CLEANUP_API_WORKER_DB_EVIDENCE_DIR' &&
  JSON.stringify(HELPER.WORKER_IDS) === '["1","2"]' &&
  JSON.stringify(HELPER.APPROVED_BASES) === '["capiro","fo_v2_test"]');
check('defaultWorkerMap returns both clones and null for an unknown base',
  JSON.stringify(HELPER.defaultWorkerMap('capiro')) === JSON.stringify({ '1': 'capiro_worker_1', '2': 'capiro_worker_2' }) &&
  HELPER.defaultWorkerMap('nope') === null);
check('requiring the helper did NOT bind in this (disabled) control process',
  process.env.DATABASE_URL === undefined || !String(process.env.DATABASE_URL).includes('_worker_'));

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  controls: results.length,
  passed,
  failed: failed.length,
  failures: failed,
  sourceLevelEvidenceOnly: true,
  dockerGitSpawned: false,
  C1Acceptance: false,
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
