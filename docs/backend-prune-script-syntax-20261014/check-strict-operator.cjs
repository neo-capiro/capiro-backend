const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString();
const head = git(['rev-parse', 'HEAD']).trim();
const rootPath = 'apps/api/scripts/prune-stale-assistance-recipient-candidates.ts';
const config = path.join(root, 'apps/api/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
assert(parsed && parsed.errors.length === 0);
const options = { ...parsed.options, strict: true, noEmit: true, incremental: false };
const host = ts.createCompilerHost(options);
const originalRead = host.readFile.bind(host);
const originalExists = host.fileExists.bind(host);
const product = new Map();
function productSource(filename) {
  const relative = path.relative(root, path.resolve(filename)).split(path.sep).join('/');
  if (!relative.startsWith('apps/api/') || !relative.endsWith('.ts') || relative.includes('/node_modules/')) return null;
  if (/engagement[.]service[.]|(^|\/)meri\/meri[.]service[.]|e01e3b72/.test(relative)) throw new Error('Unbounded or protected source refused');
  if (!product.has(relative)) {
    const source = git(['show', `${head}:${relative}`]);
    if (originalExists(filename)) assert.equal(originalRead(filename), source, `Current source differs from exact head: ${relative}`);
    product.set(relative, source);
  }
  return product.get(relative);
}
host.readFile = (filename) => productSource(filename) ?? originalRead(filename);
host.fileExists = (filename) => {
  const relative = path.relative(root, path.resolve(filename)).split(path.sep).join('/');
  if (relative.startsWith('apps/api/') && relative.endsWith('.ts') && !relative.includes('/node_modules/')) {
    if (originalExists(filename)) return true;
    const result = cp.spawnSync('git', ['cat-file', '-e', `${head}:${relative}`], { cwd: root });
    return result.status === 0;
  }
  return originalExists(filename);
};
const program = ts.createProgram([path.join(root, rootPath)], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
const productInputs = program.getSourceFiles().filter((file) => !file.isDeclarationFile).map((file) => {
  const relative = path.relative(root, file.fileName).split(path.sep).join('/');
  assert(relative.startsWith('apps/api/'));
  assert.equal(file.text, git(['show', `${head}:${relative}`]));
  return { path: relative, bytes: Buffer.byteLength(file.text), sha256: sha(file.text), blob: git(['rev-parse', `${head}:${relative}`]).trim() };
});
const declarations = program.getSourceFiles().filter((file) => file.isDeclarationFile).map((file) => ({ path: file.fileName, sha256: sha(file.text) }));
console.log(JSON.stringify({ head, tree: git(['rev-parse', 'HEAD^{tree}']).trim(), result: diagnostics.length ? 'fail' : 'pass',
  strict: true, noEmit: true, incremental: false, compilerOptions: { ...options, configFile: undefined },
  nodeVersion: process.version, typescriptVersion: ts.version, productInputs,
  declarationFiles: declarations.length, declarationManifestSha256: sha(JSON.stringify(declarations)),
  diagnostics: diagnostics.map((d) => ({ code: d.code, file: d.file?.fileName, start: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') })),
  scope: 'Actual complete operator strict compiler program using exact current source and cached declarations; no operator/import graph/database/native execution or full API qualification',
}, null, 2));
if (diagnostics.length) process.exitCode = 1;
