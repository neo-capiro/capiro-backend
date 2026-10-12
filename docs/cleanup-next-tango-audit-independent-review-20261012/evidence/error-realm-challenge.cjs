// Independent, pure original-fragment challenge. No client construction, fetch,
// timers, bootstrap, provider, database, process or production mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const packet = 'docs/cleanup-next-tango-seam-audit-20261012/evidence/';
const author = JSON.parse(fs.readFileSync(packet + 'original-envelope-profiles.json', 'utf8'));
const harness = fs.readFileSync(packet + 'original-envelope-profiles.mjs', 'utf8');
const hs = ts.createSourceFile('harness.mjs', harness, ts.ScriptTarget.Latest, true);
const inputDeclaration = hs.statements.filter(ts.isVariableStatement)
  .flatMap((s) => [...s.declarationList.declarations]).find((d) => d.name.getText(hs) === 'inputs');
assert(inputDeclaration);
// These are the same inspected, source-only authored factory literals. They and
// intrinsic errors execute in one host realm for the corrected comparison.
const inputs = new Function('return (' + inputDeclaration.initializer.getText(hs) + ');')();
const errorSource = fs.readFileSync('apps/api/src/external/tango/tango.errors.ts', 'utf8');
const es = ts.createSourceFile('errors.ts', errorSource, ts.ScriptTarget.Latest, true);
const notConfigured = es.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'TangoNotConfiguredError').getText(es);
const results = [];
for (const name of ['dibbs', 'sbir', 'subaward']) {
  const file = `apps/api/src/external/tango/tango-${name}.client.ts`;
  const text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const client = ast.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === `Tango${name[0].toUpperCase() + name.slice(1)}Client`);
  const method = client.members.find((s) => ts.isMethodDeclaration(s) && s.name.getText(ast) === (name === 'subaward' ? 'listSubawards' : 'list'));
  const block = method.body.statements.find(ts.isTryStatement);
  const start = block.tryBlock.statements.findIndex((s) => ts.isVariableStatement(s)
    && s.declarationList.declarations.some((d) => d.name.getText(ast) === 'parsed'));
  const parser = [...block.tryBlock.statements].slice(start).map((s) => s.getText(ast)).join('\n');
  const classes = ast.statements.filter((s) => ts.isClassDeclaration(s) && s !== client).map((s) => s.getText(ast)).join('\n');
  const helpers = ast.statements.filter(ts.isFunctionDeclaration).map((s) => s.getText(ast)).join('\n');
  const fragment = `${notConfigured}\n${classes}\n${helpers}\nexport function decode(rawText: string,response: any) { const label='fixture'; try { ${parser} } ${block.catchClause.getText(ast)} }`;
  const code = ts.transpileModule(fragment, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  assert(!/\b(?:fetch|fetchImpl|setTimeout|clearTimeout|AbortController|process|require)\b/.test(code));
  const parserHash = crypto.createHash('sha256').update(parser).digest('hex');
  for (const [label, factory] of inputs) {
    const evaluate = (realm) => {
      const input = factory();
      const exports = {};
      const parse = { parse: () => input };
      if (realm === 'author-vm-host-Error') {
        vm.runInNewContext(code, { exports, JSON: parse, URL, Number, Math, Error });
      } else {
        new Function('exports', 'JSON', 'URL', 'Number', 'Math', 'Error', code)(exports, parse, URL, Number, Math, Error);
      }
      let result;
      try { result = { returned: exports.decode.call({ baseUrl: 'https://tango.makegov.com', timeoutMs: 30_000 }, 'synthetic', { status: 200, headers: new Headers() }) }; }
      catch (error) { result = { threw: { name: error.name, status: error.status, message: error.message, rate: error.rate } }; }
      return JSON.parse(JSON.stringify({ result, getterReads: input?.reads }));
    };
    const observed = evaluate('author-vm-host-Error');
    const coherent = evaluate('coherent-host-realm');
    const recorded = author.results.find((r) => r.client === name && r.label === label);
    assert.equal(recorded.parserSha256, parserHash);
    assert.equal(JSON.stringify(observed), JSON.stringify(JSON.parse(JSON.stringify({ result: recorded.result, getterReads: recorded.getterReads }))));
    results.push({ client: name, label, parserSha256: parserHash, authored: observed, coherent,
      equal: JSON.stringify(observed) === JSON.stringify(coherent) });
  }
}
const differences = results.filter((r) => !r.equal);
assert.equal(results.length, 54);
assert.equal(differences.length, 4);
assert(differences.every((r) => r.authored.result.threw.message === 'TypeError: ' + r.coherent.result.threw.message));
console.log(JSON.stringify({ authorHead: 'ed43dbb5bad37763688a9553680253f9b756fca1',
  authorTree: 'a11b987ee629d316a7074cd0587716216137599f', source: '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70',
  originalParserSourceSlicesAndAuthorVmResultsExact: true, cases: 18, clients: 3,
  vmOriginalExecutions: 54, coherentOriginalExecutions: 54, sameResults: 50,
  coherentOriginalResults: results.map((r) => ({ client: r.client, label: r.label,
    parserSha256: r.parserSha256, ...r.coherent })),
  authoredMessageDifferences: differences,
  explanation: 'The authored VM binds host Error but engine-generated property/call TypeErrors inherit the VM intrinsic Error; instanceof host Error is false and String(error) adds a TypeError prefix. Original production source in one realm uses error.message.',
  remainingEvidenceBlocker: 'Four authored malformed-envelope error messages are realm artifacts; qualify or supplement before using them as authoritative preconversion golden decisions.',
  productionImplementationAccepted: false, clientConstructorExecuted: false,
  clientFetchOrTimerOrProviderExecuted: false, nativeAcceptance: false,
}, null, 2));
