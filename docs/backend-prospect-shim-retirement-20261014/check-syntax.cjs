const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const source = '85d582c35a9971538a709225ebaf0e0a762073c6';
const base = '917fed9be648dc4abfd6770e0e391ce2e3fe3928';
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trimEnd();
const rows = git('diff', '--name-only', base, source).split('\n').map((file) => {
  const text = cp.execFileSync('git', ['show', `${source}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  if (parsed.parseDiagnostics.length) throw new Error(`Parse diagnostics: ${file}`);
  const emitted = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true, useDefineForClassFields: false,
  } });
  if (emitted.diagnostics?.length) throw new Error(`Transpile diagnostics: ${file}`);
  cp.execFileSync(process.execPath, ['--check'], { input: emitted.outputText });
  return { path: file, blob: git('rev-parse', `${source}:${file}`), sourceSha256: crypto.createHash('sha256').update(text).digest('hex'),
    emittedSha256: crypto.createHash('sha256').update(emitted.outputText).digest('hex'), parseDiagnostics: 0, transpileDiagnostics: 0, nodeSyntax: 'pass' };
});
console.log(JSON.stringify({ result: 'pass', source, sourceTree: git('rev-parse', `${source}^{tree}`), rows,
  qualification: 'All six changed TS files parse/transpile; generated CommonJS syntax checked from stdin. No runtime imports, provider construction, semantic checking of entire caller classes, or Core/native acceptance.' }, null, 2));
