import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const compiler = createRequire('/workspace/capirov2/package.json')('typescript');
const names = ['dibbs', 'sbir', 'subaward'];
const originals = names.map((name) => {
  const file = `apps/api/src/external/tango/tango-${name}.client.ts`;
  const text = readFileSync(file, 'utf8');
  const sf = compiler.createSourceFile(file, text, compiler.ScriptTarget.Latest, true);
  const declarations = sf.statements.filter((node) => compiler.isFunctionDeclaration(node) && ['asCount', 'nextPageOf', 'rateOf'].includes(node.name?.text));
  assert.equal(declarations.length, 3);
  const exports = {};
  const pure = declarations.map((node) => 'export ' + node.getText(sf)).join('\n');
  vm.runInNewContext(compiler.transpileModule(pure, {
    compilerOptions: { module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022 },
  }).outputText, { exports, URL, Number, Math, Error });
  return { name, file, sourceSha256: createHash('sha256').update(text).digest('hex'), exports };
});
function outcome(fn) {
  try { return { returned: JSON.parse(JSON.stringify(fn())) }; }
  catch (error) { return { threw: { name: error.name, message: error.message } }; }
}
const results = [];
function compare(kind, name, factory) {
  const observed = originals.map((client) => ({ client: client.name, outcome: outcome(() => factory(client.exports)) }));
  assert.deepEqual(observed[1].outcome, observed[0].outcome, kind + ': ' + name);
  assert.deepEqual(observed[2].outcome, observed[0].outcome, kind + ': ' + name);
  results.push({ kind, name, observed, equal: true });
}
const countValues = [undefined, null, '', ' ', 0, -1, 1.9, '2.9', true, false, NaN, Infinity, -Infinity, 'NaN', '1e3', [], [2], {}, 2n, Symbol('count')];
countValues.forEach((value, index) => compare('asCount', `coercion ${index}: ${String(value)}`, (api) => api.asCount(value)));
compare('asCount', 'inherited count property', (api) => api.asCount(Object.create({ count: '12.8' }).count));
compare('asCount', 'count getter sampled by caller once', (api) => {
  let reads = 0;
  const object = { get count() { reads++; return '7.9'; } };
  const value = api.asCount(object.count);
  return { value, reads };
});
compare('asCount', 'inherited numeric primitive conversion', (api) => api.asCount(Object.create({ valueOf() { return 4.9; } })));
compare('asCount', 'throwing count primitive conversion', (api) => api.asCount({ valueOf() { throw new Error('synthetic count coercion'); } }));
const nextValues = [undefined, null, '', ' ', 0, {}, new String('?page=2'), '?page=2', '/api/x/?page=3', 'https://other.invalid/x?page=4', 'http://other.invalid/x?page=5', '//other.invalid/x?page=6', '?page=0', '?page=-1', '?page=2.5', '?page=NaN', '?page=Infinity', '?page=1e3', '?page=', '?page=2&page=7', 'https://[invalid/?page=2', 'javascript:opaque?page=8', '__proto__?page=9'];
nextValues.forEach((value, index) => compare('nextPageOf', `next ${index}: ${String(value)}`, (api) => api.nextPageOf(value, 'https://tango.makegov.com')));
compare('nextPageOf', 'invalid base URL remains null', (api) => api.nextPageOf('?page=2', 'not a URL'));
compare('nextPageOf', 'inherited next field', (api) => api.nextPageOf(Object.create({ next: '?page=3' }).next, 'https://tango.makegov.com'));
const headerValues = [null, '', ' ', '0', '-2', '3.9', '1e6', 'Infinity', 'NaN', 'Wed, 21 Oct 2015 07:28:00 GMT', undefined, 2, false];
for (const [index, value] of headerValues.entries()) compare('rateOf', `header coercion ${index}`, (api) => {
  const reads = [];
  const headers = { get(name) { reads.push(name); return name === 'x-ratelimit-type' ? null : value; } };
  const rate = api.rateOf(headers);
  return { rate, reads };
});
compare('rateOf', 'native Headers with mixed values', (api) => api.rateOf(new Headers({ 'x-ratelimit-remaining': '4.5', 'x-ratelimit-limit': '25', 'x-ratelimit-reset-in': '-1', 'retry-after': '2', 'x-ratelimit-type': 'burst' })));
compare('rateOf', 'empty limitType is present', (api) => api.rateOf(new Headers({ 'x-ratelimit-type': '' })));
compare('rateOf', 'inherited get method preserves receiver', (api) => {
  const headers = Object.create({ get(name) { assert.equal(this.marker, 'receiver'); return name === 'x-ratelimit-limit' ? '25.8' : null; } });
  headers.marker = 'receiver';
  return api.rateOf(headers);
});
compare('rateOf', 'get property getter reads and binds every call', (api) => {
  let reads = 0;
  const headers = { marker: 'receiver', get get() { reads++; return function(name) { assert.equal(this.marker, 'receiver'); return name === 'retry-after' ? '3' : null; }; } };
  const rate = api.rateOf(headers);
  return { rate, reads };
});
compare('rateOf', 'missing get method throws unchanged', (api) => api.rateOf({}));
compare('rateOf', 'throwing inherited get method', (api) => api.rateOf(Object.create({ get() { throw new Error('synthetic header failure'); } })));
// Outside Headers#get's string|null contract, object coercion can expose the
// existing different get-versus-Number interleaving. Record it, do not pretend
// arbitrary malformed transports are identical or silently broaden the seam.
const outOfContractHeaderTrace = originals.map((client) => {
  const trace = [];
  const headers = { get(name) {
    trace.push('get:' + name);
    if (name === 'x-ratelimit-type') return null;
    return { valueOf() { trace.push('coerce:' + name); return 2; } };
  } };
  return { client: client.name, rate: client.exports.rateOf(headers), trace };
});
assert.deepEqual(outOfContractHeaderTrace[0].trace, outOfContractHeaderTrace[1].trace);
assert.notDeepEqual(outOfContractHeaderTrace[0].trace, outOfContractHeaderTrace[2].trace);
const outOfContractThrowTrace = originals.map((client) => {
  const trace = [];
  const headers = { get(name) {
    trace.push('get:' + name);
    if (name === 'x-ratelimit-type') return null;
    return { valueOf() { trace.push('coerce:' + name); throw new Error('synthetic numeric coercion failure'); } };
  } };
  return { client: client.name, outcome: outcome(() => client.exports.rateOf(headers)), trace };
});
assert.equal(outOfContractThrowTrace[0].trace.length, 2);
assert.equal(outOfContractThrowTrace[1].trace.length, 2);
assert.equal(outOfContractThrowTrace[2].trace.length, 5);
assert.deepEqual(outOfContractThrowTrace[0].outcome, outOfContractThrowTrace[2].outcome);
const outOfContractMutationTrace = originals.map((client) => {
  const trace = [];
  let state = 0;
  const headers = { get(name) {
    trace.push('get:' + name + ':state=' + state);
    if (name === 'x-ratelimit-type') return null;
    const captured = state;
    return { valueOf() { trace.push('coerce:' + name); state++; return captured; } };
  } };
  return { client: client.name, rate: client.exports.rateOf(headers), trace };
});
assert.equal(outOfContractMutationTrace[0].rate.limit, 1);
assert.equal(outOfContractMutationTrace[1].rate.limit, 1);
assert.equal(outOfContractMutationTrace[2].rate.limit, 0);
const receipt = {
  source: '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70',
  tree: 'f14d6fa3f191645839414972063e1057fce557bf',
  originalClients: originals.map(({ exports: ignored, ...client }) => client),
  cases: results.length, originalExecutions: results.length * 3, results,
  profileProbeCases: 3, profileProbeExecutions: 9, totalOriginalLeafExecutions: results.length * 3 + 9,
  outOfContractHeaderTrace, outOfContractThrowTrace, outOfContractMutationTrace,
  headerIdentityScope: 'valid Headers#get string|null values and recorded simple malformed primitives; object-valued coercion trace differs and is not claimed equivalent',
  scope: 'actual original pure declarations only; no constructor, fetch, timeout, full client, or provider execution',
  productionSourceEdits: false, providerCalls: false, nativeOperations: false,
};
writeFileSync(new URL('original-leaf-differential.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length, originalExecutions: receipt.originalExecutions, profileProbeCases: receipt.profileProbeCases, profileProbeExecutions: receipt.profileProbeExecutions, totalOriginalLeafExecutions: receipt.totalOriginalLeafExecutions, allThreeMainOutputsEqual: true, providerCalls: false, source: receipt.source }, null, 2));
