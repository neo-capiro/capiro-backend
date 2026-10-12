const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const OUT = 'docs/cleanup-strategy-template-conversion-20261012/evidence/';
const paths = ['apps/api-strategy/src/context/frontmatter.ts', 'apps/api-strategy/src/reports/report-context.ts'];
const configPath = path.resolve(OUT, 'full-strategy-cached-types.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys, onUnRecoverableConfigFileDiagnostic(diagnostic) { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
});
const options = { ...parsed.options, noEmit: false, declaration: true, emitDeclarationOnly: true, incremental: false };
const originals = new Map(paths.map((file, i) => [path.resolve(file), fs.readFileSync(OUT + ['original-frontmatter.ts', 'original-report-context.ts'][i], 'utf8')]));
function emit(before) {
  const host = ts.createCompilerHost(options);
  const originalGet = host.getSourceFile.bind(host);
  host.getSourceFile = (file, target, onError, createNew) => before && originals.has(path.resolve(file))
    ? ts.createSourceFile(file, originals.get(path.resolve(file)), target, true)
    : originalGet(file, target, onError, createNew);
  const emitted = new Map();
  host.writeFile = (file, content) => emitted.set(file, content);
  const program = ts.createProgram(paths.map(file => path.resolve(file)), options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  }));
  const result = program.emit(); assert.equal(result.emitSkipped, false);
  return emitted;
}
const before = emit(true), after = emit(false), compared = [];
for (const [source, outputName] of [['frontmatter.ts', 'frontmatter.d.ts'], ['report-context.ts', 'report-context.d.ts']]) {
  const old = [...before].find(([name]) => name.endsWith('/' + outputName));
  const current = [...after].find(([name]) => name.endsWith('/' + outputName));
  assert(old && current); assert.equal(current[1], old[1], source);
  fs.writeFileSync(OUT + 'public-' + outputName, current[1]);
  compared.push({ source, declaration: outputName, exactOriginalDeclarationBytes: true });
}
const result = { baseline: '802bbd0b2c510a44e46a9952d8127e7edc55aaaa', compared,
  originalAndCandidateStrictDiagnostics: 0, runtimeModuleBodiesExecuted: false, nativeGenerateExecuted: false };
fs.writeFileSync(OUT + 'public-declarations.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
