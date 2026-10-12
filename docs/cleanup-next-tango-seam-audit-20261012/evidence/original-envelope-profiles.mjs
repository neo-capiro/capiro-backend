import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const compiler = createRequire('/workspace/capirov2/package.json')('typescript');
const results = [];
const exceptionsSource = readFileSync('apps/api/src/external/tango/tango.errors.ts', 'utf8');
const exceptionsSf = compiler.createSourceFile('errors.ts', exceptionsSource, compiler.ScriptTarget.Latest, true);
const notConfigured = exceptionsSf.statements.find((node) => compiler.isClassDeclaration(node) && node.name?.text === 'TangoNotConfiguredError').getText(exceptionsSf);
const inputs = [
  ['null', () => null], ['array root', () => []], ['string root', () => 'x'], ['number root', () => 7],
  ['boolean root', () => true], ['missing results', () => ({})], ['null results', () => ({ results: null })],
  ['nonarray results', () => ({ results: 'records' })], ['object results', () => ({ results: {} })],
  ['empty valid page', () => ({ results: [], count: 0, next: null })],
  ['mixed rows', () => ({ results: [null, [], 'x', 7, {}, Object.create({ key: 'inherited' })] })],
  ['wrong count string', () => ({ results: [], count: 'wrong' })],
  ['null count coerces to zero', () => ({ results: [], count: null })],
  ['inherited page fields', () => Object.create({ results: [{ key: 'row' }], count: '3.8', next: '?page=2' })],
  ['getters read in original order', () => {
    const reads = [];
    return { reads, get results() { reads.push('results'); return []; }, get count() { reads.push('count'); return '2.4'; }, get next() { reads.push('next'); return '?page=3'; } };
  }],
  ['changing results getter', () => { let count = 0; return { get results() { return ++count === 1 ? [] : 'changed'; } }; }],
  ['throwing count getter', () => ({ results: [], get count() { throw new Error('synthetic count getter'); } })],
  ['symbol count', () => ({ results: [], count: Symbol('invalid count') })],
];
for (const name of ['dibbs', 'sbir', 'subaward']) {
  const file = `apps/api/src/external/tango/tango-${name}.client.ts`;
  const source = readFileSync(file, 'utf8');
  const sf = compiler.createSourceFile(file, source, compiler.ScriptTarget.Latest, true);
  const client = sf.statements.find((node) => compiler.isClassDeclaration(node) && node.name?.text === `Tango${name[0].toUpperCase()+name.slice(1)}Client`);
  const method = client.members.find((node) => compiler.isMethodDeclaration(node) && node.name.getText(sf) === (name === 'subaward' ? 'listSubawards' : 'list'));
  const block = method.body.statements.find((node) => compiler.isTryStatement(node));
  const start = block.tryBlock.statements.findIndex((node) => compiler.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(sf) === 'parsed'));
  assert(start > 0);
  const parser = [...block.tryBlock.statements].slice(start).map((node) => node.getText(sf)).join('\n');
  // Extract only successful-body parsing and its existing error conversion.
  // Neither request setup/fetch/text/timer nor any constructor is executed.
  const classes = sf.statements.filter((node) => compiler.isClassDeclaration(node) && node !== client).map((node) => node.getText(sf)).join('\n');
  const helpers = sf.statements.filter((node) => compiler.isFunctionDeclaration(node)).map((node) => node.getText(sf)).join('\n');
  const decoded = `${notConfigured}\n${classes}\n${helpers}\nexport function decode(rawText: string,response: any) { const label='fixture'; try { ${parser} } ${block.catchClause.getText(sf)} }`;
  const javascript = compiler.transpileModule(decoded, { compilerOptions: { module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022 } }).outputText;
  for (const [label, factory] of inputs) {
    const input = factory();
    const exports = {};
    vm.runInNewContext(javascript, { exports, JSON: { parse: () => input }, URL, Number, Math, Error });
    let result;
    try { result = { returned: exports.decode.call({ baseUrl: 'https://tango.makegov.com', timeoutMs: 30_000 }, 'synthetic', { status: 200, headers: new Headers() }) }; }
    catch (error) { result = { threw: { name: error.name, status: error.status, message: error.message, rate: error.rate } }; }
    results.push({ client: name, label, parserSha256: createHash('sha256').update(parser).digest('hex'), result, getterReads: input?.reads });
  }
}
const get = (client, label) => results.find((result) => result.client === client && result.label === label);
assert.equal(get('dibbs', 'missing results').result.threw.name, 'TangoDibbsEnvelopeError');
assert.equal(get('sbir', 'missing results').result.threw.name, 'TangoSbirEnvelopeError');
assert.equal(get('subaward', 'missing results').result.returned.items.length, 0);
assert.equal(get('subaward', 'null').result.threw.status, 0);
assert.equal(get('dibbs', 'null').result.threw.name, 'TangoDibbsEnvelopeError');
for (const client of ['dibbs', 'sbir', 'subaward']) {
  assert.deepEqual(get(client, 'getters read in original order').getterReads, ['results','results','count','next']);
  assert.equal(get(client, 'changing results getter').result.threw.status, 0);
  assert.equal(get(client, 'inherited page fields').result.returned.totalCount, 3);
}
writeFileSync(new URL('original-envelope-profiles.json', import.meta.url), JSON.stringify({
  source: '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70', cases: inputs.length,
  originalParserExecutions: results.length, results,
  scope: 'original success-parser/catch fragments only; synthetic parsed objects; envelope code remains client-owned',
  providerCalls: false, timersOrFetchExecuted: false, productionSourceEdits: false,
}, null, 2) + '\n');
console.log(JSON.stringify({ cases: inputs.length, originalParserExecutions: results.length, profileDifferencesRetained: true, providerCalls: false, timersOrFetchExecuted: false }, null, 2));
