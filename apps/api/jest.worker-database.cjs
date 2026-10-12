'use strict';

/**
 * jest.worker-database.cjs  (CleanUp1 api643 — bounded per-worker DB isolation)
 *
 * A committed, test-only Jest `setupFiles` entry (wired BEFORE jest.setup.ts in
 * jest.config.cjs) that runs inside EVERY real Jest fork, in the fork's own
 * realm, BEFORE any test module is imported. It binds that fork's inherited
 * default `DATABASE_URL` to its own bootstrapped disposable per-worker clone so
 * the real Jest pool (`maxWorkers: 2`) can run the DATABASE-WIDE integration
 * suites concurrently without colliding on global uniqueness.
 *
 * OPT-IN ONLY
 * -----------
 * The helper is a STRICT NO-OP unless it is explicitly enabled by the dedicated
 * test-only flag `CLEANUP_API_WORKER_DB=1`. DB-free / local / unit runs never
 * set it, so `DATABASE_URL` (if any) is left exactly as-is. This keeps the whole
 * 1852-suite default identity set unchanged and never perturbs a deliverable
 * that does not opt in.
 *
 * WHAT IT DOES (when enabled)
 * ---------------------------
 *   * no worker (`JEST_WORKER_ID` absent/blank -> master/no-worker): no-op;
 *   * an actual fork (`JEST_WORKER_ID` in {'1','2'}) whose inherited default
 *     `DATABASE_URL` still points at an APPROVED base database (`capiro` or
 *     `fo_v2_test`) is rewritten to `<base>_worker_<id>`;
 *   * a fork whose `DATABASE_URL` ALREADY points at the exact matching
 *     `<base>_worker_<id>` (for example because the externally-owned native
 *     preload already bound this real fork) is accepted IDEMPOTENTLY and never
 *     re-bound — the two helpers cooperate instead of fighting;
 *   * host, port, role and query string are preserved byte-for-byte; every
 *     dedicated `*_TEST_DATABASE_URL` env is left untouched.
 *
 * FAIL-CLOSED
 * -----------
 * When ENABLED, a missing/blank `DATABASE_URL`, an invalid worker id, a
 * missing/incorrect token, a malformed mapping, a mapping that is not the
 * CANONICAL exact targets for the selected approved base (swapped / arbitrary /
 * cross-base), a non-postgres scheme, a non-loopback host, an unknown base
 * database, a swapped/wrong-worker binding, or a target that is not a safe
 * identifier THROWS at require time — a mis-wired
 * fork can never silently run against the shared database.
 *
 * FILTERS / SIDE EFFECTS
 * ----------------------
 * No database connection and no migration is ever opened from this file; it
 * only rewrites an env string. The optional exact evidence directory records an
 * immutable per-process receipt (pid / parent pid / worker id / bound DB, never
 * a password) for diagnostics only — it is NEVER a boolean substitute for a
 * native test result.
 *
 * The pure helpers (`resolveWorkerDatabase`, `workerDatabaseForId`, ...) are
 * exported so jest.worker-database-controls.cjs can drive the EXACT same logic
 * with synthetic env objects.
 */

const ENABLED_ENV = 'CLEANUP_API_WORKER_DB';
const TOKEN_ENV = 'CLEANUP_API_WORKER_DB_TOKEN';
const TOKEN = 'cleanup-api-worker-db-v1';
const MAP_ENV = 'CLEANUP_API_WORKER_DB_MAP';
const EVIDENCE_ENV = 'CLEANUP_API_WORKER_DB_EVIDENCE_DIR';
const VERBOSE_ENV = 'CLEANUP_API_WORKER_DB_VERBOSE';
const MARKER = '[cleanup_api_worker_db]';

/** Fixed two-worker pool. Worker ids are 1-based and match the bootstrap clone
 * creation order (`<base>_worker_1`, `<base>_worker_2`). */
const WORKER_IDS = Object.freeze(['1', '2']);

/** Only these two source databases may be split into worker clones. */
const APPROVED_BASES = Object.freeze(['capiro', 'fo_v2_test']);

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
// Real Node reports an IPv6 loopback literal hostname as '[::1]' (bracketed);
// accept that ACTUAL shape alongside the textual forms.  Non-loopback hosts
// (including non-loopback IPv6 literals) remain rejected.
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]']);

function fail(reason) {
  throw new Error(MARKER + ' ' + reason + ' (fail closed)');
}

/**
 * Pure: the default worker-id -> database map for an approved base database.
 * Returns null for a non-approved base (the caller then fails closed).
 */
function workerDatabaseForId(workerId, base) {
  if (WORKER_IDS.indexOf(String(workerId)) === -1) return null;
  if (APPROVED_BASES.indexOf(String(base)) === -1) return null;
  return String(base) + '_worker_' + String(workerId);
}

/** Pure: the full { '1': ..., '2': ... } default map for an approved base. */
function defaultWorkerMap(base) {
  if (APPROVED_BASES.indexOf(String(base)) === -1) return null;
  const map = {};
  for (const id of WORKER_IDS) map[id] = workerDatabaseForId(id, base);
  return map;
}

function parseMapping(env) {
  const raw = env[MAP_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    fail('malformed ' + MAP_ENV + ' (not valid JSON)');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('malformed ' + MAP_ENV + ' (not a JSON object)');
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== WORKER_IDS.slice().sort().join(',')) {
    fail('malformed ' + MAP_ENV + ' (keys must be exactly "1","2")');
  }
  const map = {};
  for (const id of WORKER_IDS) {
    const value = parsed[id];
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
      fail('malformed ' + MAP_ENV + ' (worker ' + id + ' target is not a safe identifier)');
    }
    map[id] = value;
  }
  return map;
}

function loopbackHost(hostname) {
  return LOOPBACK_HOSTS.indexOf(String(hostname)) !== -1;
}

function databaseFromPathname(pathname) {
  return decodeURIComponent(String(pathname).replace(/^\//, ''));
}

/**
 * Pure: resolve the worker-bound database for a synthetic env object.
 *
 * Returns { enabled, applied, workerId, database, databaseUrl, reason } and
 * throws (fail closed) on any of the enabled-mode mis-wirings. Never connects to
 * a database and never mutates its input.
 */
function resolveWorkerDatabase(env) {
  const source = env || {};
  if (String(source[ENABLED_ENV]) !== '1') {
    return {
      enabled: false,
      applied: false,
      workerId: null,
      database: null,
      databaseUrl: typeof source.DATABASE_URL === 'string' ? source.DATABASE_URL : null,
      reason: 'not-enabled',
    };
  }

  const rawWorkerId = source.JEST_WORKER_ID;
  if (rawWorkerId === undefined || rawWorkerId === null || String(rawWorkerId) === '') {
    return {
      enabled: true,
      applied: false,
      workerId: null,
      database: null,
      databaseUrl: typeof source.DATABASE_URL === 'string' ? source.DATABASE_URL : null,
      reason: 'no-worker/master',
    };
  }
  const workerId = String(rawWorkerId);
  if (WORKER_IDS.indexOf(workerId) === -1) {
    fail('invalid JEST_WORKER_ID=' + workerId + '; refusing to bind');
  }
  if (source[TOKEN_ENV] !== TOKEN) {
    fail('missing/incorrect ' + TOKEN_ENV + '; refusing to bind worker ' + workerId);
  }

  const base = source.DATABASE_URL;
  if (typeof base !== 'string' || base.trim() === '') {
    fail('DATABASE_URL is absent/blank; refusing to bind worker ' + workerId);
  }
  let parsed;
  try {
    parsed = new URL(base);
  } catch (error) {
    fail('DATABASE_URL is not a valid URL; refusing to bind worker ' + workerId);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    fail('DATABASE_URL scheme ' + parsed.protocol + ' is not postgres; refusing to bind ' + workerId);
  }
  if (!loopbackHost(parsed.hostname)) {
    fail('DATABASE_URL host ' + parsed.hostname + ' is not loopback; refusing to bind ' + workerId);
  }
  const database = databaseFromPathname(parsed.pathname);
  if (database === '') {
    fail('DATABASE_URL has no database name; refusing to bind worker ' + workerId);
  }

  const explicit = parseMapping(source);
  const boundPattern = /^(capiro|fo_v2_test)_worker_(1|2)$/.exec(database);
  // The approved base the URL selects: either the URL's own approved base name
  // or the base of the worker clone the URL is ALREADY bound to.
  const selectedBase = APPROVED_BASES.indexOf(database) !== -1 ? database
    : (boundPattern ? boundPattern[1] : null);

  if (explicit) {
    if (selectedBase === null) {
      fail('DATABASE_URL database ' + database + ' is not an approved base nor a ' +
        'worker clone of one; refusing to bind ' + workerId);
    }
    // The explicit map is validated against the CANONICAL exact targets for the
    // selected approved base — never merely "safe identifiers".  A swapped,
    // arbitrary or cross-base mapping is rejected BEFORE any rebinding.
    const canonical = defaultWorkerMap(selectedBase);
    for (const id of WORKER_IDS) {
      if (explicit[id] !== canonical[id]) {
        fail('malformed ' + MAP_ENV + ' (worker ' + id + ' target ' + explicit[id] +
          ' != the canonical ' + canonical[id] + ' for approved base ' + selectedBase +
          '); refusing to bind ' + workerId);
      }
    }
    if (boundPattern && boundPattern[2] !== workerId) {
      fail('DATABASE_URL is bound to worker ' + boundPattern[2] + "'s clone (" + database +
        ') for worker ' + workerId + '; refusing to rebind a swapped worker');
    }
    const target = canonical[workerId];
    if (database === target) {
      return { enabled: true, applied: false, workerId, database,
        databaseUrl: base, reason: 'already-bound' };
    }
    if (database !== selectedBase) {
      fail('DATABASE_URL database ' + database + ' does not select the approved base ' +
        selectedBase + ' for worker ' + workerId + '; refusing to bind');
    }
    parsed.pathname = '/' + target;
    return { enabled: true, applied: true, workerId, database: target,
      databaseUrl: parsed.toString(), reason: 'bound' };
  }

  // No explicit mapping: derive from the approved base, but first recognize an
  // already-bound real fork (cooperate idempotently with the external preload).
  if (boundPattern) {
    const nameWorker = boundPattern[2];
    if (nameWorker !== workerId) {
      fail('DATABASE_URL is bound to worker ' + nameWorker + "'s clone (" + database +
        ') for worker ' + workerId + '; refusing to rebind a swapped worker');
    }
    return { enabled: true, applied: false, workerId, database, databaseUrl: base, reason: 'already-bound' };
  }
  if (APPROVED_BASES.indexOf(database) === -1) {
    fail('DATABASE_URL database ' + database + ' is not an approved base; refusing to bind ' + workerId);
  }
  const target = workerDatabaseForId(workerId, database);
  parsed.pathname = '/' + target;
  return { enabled: true, applied: true, workerId, database: target,
    databaseUrl: parsed.toString(), reason: 'bound' };
}

function emitMarker(message) {
  if (process.env[VERBOSE_ENV] !== '1') return;
  // STDERR only: never pollute a spawned child's STDOUT.
  try {
    process.stderr.write(MARKER + ' ' + message + '\n');
  } catch (error) {
    /* diagnostics must never affect binding */
  }
}

/** Best-effort immutable per-process receipt (never a test-result claim). */
function writeReceipt(outcome) {
  const dir = process.env[EVIDENCE_ENV];
  if (!dir || outcome.workerId === null) return;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const url = new URL(outcome.databaseUrl);
    fs.mkdirSync(dir, { recursive: true });
    const receipt = {
      schema: 'cleanup.api.worker-db-receipt',
      schemaVersion: 1,
      pid: process.pid,
      parentPid: typeof process.ppid === 'number' ? process.ppid : null,
      jestWorkerId: outcome.workerId,
      database: outcome.database,
      boundHost: url.hostname,
      boundPort: url.port,
      boundRole: url.username,
      applied: outcome.applied,
      reason: outcome.reason,
      at: new Date().toISOString(),
    };
    // 'wx' -> immutable, one receipt per process; an existing receipt is never
    // overwritten.
    fs.writeFileSync(path.join(dir, process.pid + '.json'), JSON.stringify(receipt) + '\n', { flag: 'wx' });
  } catch (error) {
    /* evidence is diagnostic-only; never disturb the binding or the test run */
  }
}

// ---- require-time application in the EXISTING fork realm --------------------
if (String(process.env[ENABLED_ENV]) === '1') {
  const outcome = resolveWorkerDatabase(process.env);
  if (outcome.applied) {
    process.env.DATABASE_URL = outcome.databaseUrl;
  }
  writeReceipt(outcome);
  emitMarker('worker=' + outcome.workerId + ' database=' + outcome.database +
    ' applied=' + outcome.applied + ' reason=' + outcome.reason);
} else {
  emitMarker('not-enabled: no-op');
}

module.exports = {
  resolveWorkerDatabase,
  workerDatabaseForId,
  defaultWorkerMap,
  ENABLED_ENV,
  TOKEN_ENV,
  TOKEN,
  MAP_ENV,
  EVIDENCE_ENV,
  VERBOSE_ENV,
  MARKER,
  WORKER_IDS,
  APPROVED_BASES,
};
