const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertPrivateSqlNormalizationRuntime } = require('./private-sql-normalization-probe.cjs');

const api = path.resolve(__dirname, '../..');
// Offline source control only: Node strips the real owner's TypeScript. The
// sole .js dependency maps to its real .ts source; no emitted product build,
// installed/native dependency, copied transform, or fabricated passing owner.
const setup = `
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');
const api = process.argv[1];
const source = path.join(api, 'src/meri/analytics');
const runtime = path.join(source, 'private-sql-normalization-runtime.ts');
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === pathToFileURL(runtime).href && specifier === './private-sql-normalization-pins.js')
    return nextResolve('./private-sql-normalization-pins.ts', context);
  return nextResolve(specifier, context);
} });
const owner = require(runtime);
const pins = require(path.join(source, 'private-sql-normalization-pins.ts')).PRIVATE_SQL_NORMALIZATION_PINS;
const { assertPrivateSqlNormalizationRuntime } = require(path.join(api, 'scripts/qualification/private-sql-normalization-probe.cjs'));
const loads = [];
function sourceRequire(specifier) {
  loads.push(specifier);
  if (specifier === './dist/meri/analytics/private-sql-normalization-runtime.js') return owner;
  if (specifier === './dist/meri/analytics/private-sql-normalization-pins.js') return { PRIVATE_SQL_NORMALIZATION_PINS: pins };
  throw new Error('Unexpected compiled owner request: ' + specifier);
}
`;
function sourceControl(code) {
  const result = spawnSync(process.execPath, ['-e', setup + code, api], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('actual canonical owner admits this Node24 tuple and exhaustive normalization behavior', () => {
  sourceControl(`
    const result = assertPrivateSqlNormalizationRuntime(sourceRequire);
    assert.deepEqual(result.versions, pins.versions);
    assert.deepEqual(result.expectedVersions, pins.versions);
    assert.equal(result.expectedBehaviorSha256, pins.behaviorSha256);
    assert.equal(result.canonicalOwnerAdmitted, true);
    assert.equal(Object.hasOwn(result, 'measuredBehaviorSha256'), false);
    assert.equal(loads.length, 2);
  `);
});

for (const key of ['node', 'v8', 'icu', 'unicode']) {
  test(`actual canonical owner rejects ${key} drift even after an admitted call`, () => {
    sourceControl(`
      assertPrivateSqlNormalizationRuntime(sourceRequire);
      Object.defineProperty(process.versions, ${JSON.stringify(key)}, { value: 'mismatch' });
      assert.throws(() => assertPrivateSqlNormalizationRuntime(sourceRequire), /runtime tuple differs/);
    `);
  });
}

test('matching version labels cannot admit changed actual lowercase behavior', () => {
  sourceControl(`
    const original = String.prototype.toLowerCase;
    String.prototype.toLowerCase = function() {
      return this.toString().includes('Σ') ? this.toString() : original.call(this);
    };
    try {
      assert.equal(owner.privateSqlNormalizationVersionMatches(process.versions), true);
      assert.throws(() => assertPrivateSqlNormalizationRuntime(sourceRequire), /normalization behavior differs/);
    } finally { String.prototype.toLowerCase = original; }
  `);
});

test('missing or malformed compiled owner cannot produce admitted evidence', () => {
  assert.throws(() => assertPrivateSqlNormalizationRuntime(() => { throw new Error('compiled owner missing'); }), /compiled owner missing/);
  assert.throws(() => assertPrivateSqlNormalizationRuntime(() => ({})), TypeError);
});

test('ARM recipe binds both stages and copies the adapter; shared default follows canonical Node', () => {
  sourceControl(`
    const fs = require('node:fs');
    const arm = fs.readFileSync(path.join(api, 'Dockerfile.alpine-qualification'), 'utf8');
    const standard = fs.readFileSync(path.join(api, 'Dockerfile'), 'utf8');
    assert(arm.includes('ARG NODE_VERSION=' + pins.versions.node));
    assert(standard.includes('ARG NODE_VERSION=' + pins.versions.node));
    const image = 'public.ecr.aws/docker/library/node:' + pins.versions.node + '-alpine3.24@sha256:398bcf38afb035ae76feb9ad3c7493a93feff4751351c65310811761e37bbfc7';
    assert.deepEqual(arm.split('\\n').filter(line => line.startsWith('FROM public.')), ['FROM ' + image + ' AS base', 'FROM ' + image + ' AS runtime-base']);
    assert(arm.includes('COPY apps/api/scripts/qualification/private-sql-normalization-probe.cjs /qualification/private-sql-normalization-probe.cjs'));
    assert(arm.includes('RUN --network=none node /qualification/alpine-runtime-probe.cjs --static'));
  `);
});

test('normalization gate is mandatory before closure/native gates and failure stops the probe', () => {
  const probe = fs.readFileSync(path.join(__dirname, 'alpine-runtime-probe.cjs'), 'utf8');
  const gate = probe.indexOf("await check('private-sql-normalization-runtime'");
  const closure = probe.indexOf("const contract = require('./runtime-closure-contract.cjs');", gate);
  assert(gate > 0 && closure > gate);
  const boundary = probe.slice(gate, closure);
  assert(boundary.includes('assertPrivateSqlNormalizationRuntime(appRequire)'));
  assert(boundary.includes("if (normalizationGate.status !== 'PASS')"));
  assert(boundary.includes("report.status = 'FAIL'"));
  assert(boundary.includes("status: 'HOLD_BEFORE_NATIVE_EXECUTION'"));
  assert(boundary.includes('process.exitCode = 1; return;'));
  assert(!probe.includes("assert.equal(process.version, 'v22.23.4')"));
});
