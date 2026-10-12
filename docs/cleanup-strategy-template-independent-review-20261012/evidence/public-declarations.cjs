const ts = require('/workspace/capirov2/node_modules/typescript');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const files = ['apps/api-strategy/src/context/frontmatter.ts', 'apps/api-strategy/src/reports/report-context.ts'];
const originals = new Map(files.map((file) => [path.resolve(file), execFileSync('git', ['show', base + ':' + file]).toString()]));
const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
  strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true,
  experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
  types: ['node'], typeRoots: ['/workspace/capirov2/apps/api/node_modules/@types'],
  declaration: true, emitDeclarationOnly: true, incremental: false };
function emit(before) {
  const host = ts.createCompilerHost(options);
  const originalGet = host.getSourceFile.bind(host);
  host.getSourceFile = (file, target, onError, fresh) => before && originals.has(path.resolve(file))
    ? ts.createSourceFile(file, originals.get(path.resolve(file)), target, true)
    : originalGet(file, target, onError, fresh);
  const writes = new Map(); host.writeFile = (file, text) => writes.set(file, text);
  const program = ts.createProgram(files.map((file) => path.resolve(file)), options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
  assert.equal(program.emit().emitSkipped, false);
  return writes;
}
const before = emit(true), after = emit(false), rows = [];
for (const file of ['frontmatter.d.ts', 'report-context.d.ts']) {
  const old = [...before].find(([name]) => name.endsWith('/' + file));
  const current = [...after].find(([name]) => name.endsWith('/' + file));
  assert(old && current); assert.equal(old[1], current[1]);
  fs.writeFileSync(path.join(__dirname, 'public-' + file), current[1]);
  rows.push({ file, oldAndCurrentDeclarationBytesEqual: true, sha256: crypto.createHash('sha256').update(current[1]).digest('hex') });
}
console.log(JSON.stringify({ base, reviewedSource: '8834c1d76659b343fb37c60733fa1dd618a06db9',
  cachedTypeScript: ts.version, strict: true, noUncheckedIndexedAccess: true,
  oldAndCandidateDiagnostics: 0, declarationRows: rows,
  outputScope: 'Emit captured in memory; only two compared declarations written in independent evidence directory',
  configuredFullStrategyTypecheckOrNativeAcceptance: false, productionModulesExecuted: false,
}, null, 2));
