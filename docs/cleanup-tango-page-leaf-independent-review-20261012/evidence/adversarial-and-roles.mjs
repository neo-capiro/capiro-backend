import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
const ts = createRequire(import.meta.url)('typescript');
const OUT = 'docs/cleanup-tango-page-leaf-independent-review-20261012/evidence/';
const basePacket = 'docs/cleanup-tango-page-leaf-conversion-20261012/evidence/';
const compile = source => {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  assert(!/\b(?:require|fetch|setTimeout|process)\b/.test(code));
  const exports = {}; new Function('exports', code)(exports); return exports;
};
const canonical = compile(fs.readFileSync('apps/api/src/external/tango/tango-rest-page.ts', 'utf8'));
const legacy = {};
for (const client of ['dibbs', 'sbir', 'subaward']) {
  const text = fs.readFileSync(basePacket + `originals/tango-${client}.client.ts.txt`, 'utf8');
  const ast = ts.createSourceFile(client + '.ts', text, ts.ScriptTarget.Latest, true);
  legacy[client] = compile(ast.statements.filter(n => ts.isFunctionDeclaration(n) && ['asCount', 'nextPageOf', 'rateOf'].includes(n.name?.text)).map(n => 'export ' + n.getText(ast)).join('\n'));
}
const results = [];
function capture(action) { try { return { result: action() }; } catch (error) { return { error }; } }
for (const client of Object.keys(legacy)) {
  const profile = client === 'subaward' ? 'captured' : 'interleaved';
  const before = legacy[client];
  const marker = new Error('synthetic identity marker');
  for (const [label, input] of [['symbol', Symbol('synthetic count')], ['throwing toPrimitive', { [Symbol.toPrimitive]() { throw marker; } }]]) {
    const old = capture(() => before.asCount(input)), now = capture(() => canonical.asCount(input));
    assert(old.error && now.error); assert.equal(now.error.constructor, old.error.constructor); assert.equal(now.error.message, old.error.message);
    if (label !== 'symbol') assert.equal(now.error, marker);
    results.push({ client, label, exactConstructorAndMessage: true, markerIdentityRetained: label !== 'symbol' });
  }
  for (const variant of ['stable get lookup', 'coercion mutation', 'get getter throws', 'coercion throws', 'symbol limit type']) {
    const token = Symbol('synthetic type');
    function run(parse) {
      const trace = []; let state = 0, lookup = 0;
      const headers = { get get() {
        lookup++; trace.push('lookup:' + lookup);
        if (variant === 'get getter throws' && lookup === 3) throw marker;
        return function(name) {
          assert.equal(this, headers); trace.push('get:' + name + ':' + state);
          if (name === 'x-ratelimit-type') return variant === 'symbol limit type' ? token : null;
          const sampled = state;
          return { [Symbol.toPrimitive]() {
            trace.push('coerce:' + name); if (variant === 'coercion throws') throw marker;
            state++; return variant === 'coercion mutation' ? sampled : '4.9';
          } };
        };
      } };
      const outcome = capture(() => parse(headers));
      return { outcome, trace };
    }
    const old = run(before.rateOf), now = run(headers => canonical.rateOf(headers, profile));
    assert.deepEqual(now.trace, old.trace);
    if (old.outcome.error) {
      assert.equal(now.outcome.error, old.outcome.error); assert.equal(now.outcome.error, marker);
    } else assert.deepEqual(now.outcome.result, old.outcome.result);
    results.push({ client, variant, exactTrace: now.trace, exactOutcome: true, sameHostErrorRealm: true });
  }
}
const config = JSON.parse(fs.readFileSync('scripts/registry-ownership.json', 'utf8'));
const tango = { ...config, profiles: config.profiles.filter(p => p.id === 'tango-rest-page-leaves') };
assert.equal(tango.profiles.length, 1);
const sources = new Map();
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = dir + '/' + item.name;
    if (item.isDirectory()) walk(file);
    else if (item.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(file) && !/(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)/.test(file)) sources.set(file, fs.readFileSync(file, 'utf8'));
  }
}
walk('apps/api/src');
const baseline = inspectRegistryOwnership(sources, tango); assert.deepEqual(baseline.errors, []);
const changes = [
  ['named duplicate', f => f.set('apps/api/src/external/tango/review-copy.ts', 'export function asCount(v:unknown){ return 0; }')],
  ['wrong Subaward rate profile', f => { const p = 'apps/api/src/external/tango/tango-subaward.client.ts'; f.set(p, f.get(p).replace("rateOf(response.headers, 'captured')", "rateOf(response.headers, 'interleaved')")); }],
  ['missing DIBBS owner import', f => { const p = 'apps/api/src/external/tango/tango-dibbs.client.ts'; f.set(p, f.get(p).replace("import { asCount, nextPageOf, rateOf } from './tango-rest-page.js';", '')); }],
  ['new unlisted owner consumer', f => f.set('apps/api/src/external/tango/review-new-role.ts', "import { asCount } from './tango-rest-page.js'; export const count = asCount(1);")],
];
const refusals = changes.map(([name, mutate]) => {
  const f = new Map(sources); mutate(f); const result = inspectRegistryOwnership(f, tango); assert(result.errors.length > 0);
  return { name, errors: result.errors, mutantExecuted: false };
});
const result = { source: '34bd52b6f49393f49732cf1f918002ba0893574d', helperControls: results,
  helperComparisons: results.length, actualTangoProfileSourceFiles: sources.size, actualProfileBaseline: baseline,
  finiteRoleRefusals: refusals, newProfileDefaultOrMissingOperandNotAcceptedByCallerCarrier: true,
  applicationMutantCodeExecuted: false, rootGenericGrammarAcceptance: false, providersDatabaseNetworkCalls: 0 };
fs.writeFileSync(OUT + 'adversarial-and-roles.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ helperComparisons: results.length, profileFiles: sources.size, roleRefusals: refusals.length, applicationMutantCodeExecuted: false }, null, 2));
