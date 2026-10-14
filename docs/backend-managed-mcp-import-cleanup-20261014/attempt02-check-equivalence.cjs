const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const base = 'a6d4ee9d5029994925d20815b3dae0f1e7b410e3';
const file = 'apps/api/src/meri/meri.module.ts';
const ts = require(require.resolve('typescript', { paths: ['/workspace/capiro-backend-cleanup-receiving-20261014/apps/api'] }));
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trimEnd();
const read = (name) => cp.execFileSync('git', ['show', `${base}:${name}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const rows = [], configs = new Map();
const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'apps/api/tsconfig.json'), {}, {
  ...ts.sys,
  readFile: (absolute) => {
    const name = path.relative(root, absolute).split(path.sep).join('/');
    if (name.startsWith('../')) return ts.sys.readFile(absolute);
    try { const text = read(name); configs.set(name, git('rev-parse', `${base}:${name}`)); return text; }
    catch { return ts.sys.readFile(absolute); }
  },
  onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
});
assert(config && !config.errors.length, 'Actual API compiler config must parse');
const before = read(file), after = fs.readFileSync(path.join(root, file), 'utf8');
const retired = ['MeriMcpService', 'MeriMcpOAuthService', 'MeriManagedMcpService'];
let expected = before;
for (const [name, module] of [['MeriMcpService', 'meri-mcp.service'], ['MeriMcpOAuthService', 'meri-mcp-oauth.service'], ['MeriManagedMcpService', 'meri-managed-mcp.service']]) {
  const line = `import { ${name} } from './${module}.js';\n`;
  assert.equal(expected.split(line).length, 2);
  expected = expected.replace(line, '');
}
assert.equal(after, expected, 'Only three unused import lines may change');
const parsed = ts.createSourceFile(file, before, ts.ScriptTarget.Latest, true);
assert.equal(parsed.parseDiagnostics.length, 0);
const references = Object.fromEntries(retired.map((name) => [name, 0]));
function visit(node) {
  if (ts.isImportDeclaration(node)) return;
  if (ts.isIdentifier(node) && Object.hasOwn(references, node.text)) references[node.text]++;
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.deepEqual(Object.values(references), [0, 0, 0]);
const options = { ...config.options, noEmit: false, emitDeclarationOnly: false, declaration: false, incremental: false };
for (const [state, text] of [['baseline', before], ['corrected', after]]) {
  const emitted = ts.transpileModule(text, { fileName: file, compilerOptions: options, reportDiagnostics: true });
  if (emitted.diagnostics?.length) process.stderr.write(JSON.stringify(emitted.diagnostics.map((d) => ({ code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }))) + '\n');
  assert.equal(emitted.diagnostics?.length ?? 0, 0);
  assert(emitted.outputText.length > 5000, 'Nonempty real module output required');
  assert(emitted.outputText.includes('managed-mcp.module'));
  cp.execFileSync(process.execPath, ['--check'], { input: emitted.outputText });
  rows.push({ state, sourceSha256: crypto.createHash('sha256').update(text).digest('hex'),
    javascriptBytes: Buffer.byteLength(emitted.outputText), javascriptSha256: crypto.createHash('sha256').update(emitted.outputText).digest('hex'),
    sourceMapSha256: emitted.sourceMapText ? crypto.createHash('sha256').update(emitted.sourceMapText).digest('hex') : null,
    diagnostics: 0, nodeSyntax: 'pass', output: emitted.outputText });
}
assert.equal(rows[0].output, rows[1].output, 'Runtime JavaScript must remain byte-identical');
const unchanged = ['apps/api/src/meri/managed-mcp.module.ts', 'apps/api/src/meri/meri-mcp.service.ts',
  'apps/api/src/meri/meri-mcp-oauth.service.ts', 'apps/api/src/meri/meri-managed-mcp.service.ts',
  'apps/api/src/auth/application-authority.controller.ts', 'apps/api/src/tenant/tenant-context.middleware.ts',
  'apps/api/src/engagement/engagement.service.ts'].map((name) => ({ path: name, blob: git('rev-parse', `${base}:${name}`) }));
console.log(JSON.stringify({ result: 'pass', base, file, references, typescriptVersion: ts.version,
  configs: [...configs].map(([path, blob]) => ({ path, blob })), rows: rows.map(({ output, ...row }) => row),
  unchanged, scope: 'Actual API option single-file transpile and exact JavaScript equivalence; source-map changes are source positions. No semantic full graph, service construction, DI/native/database/provider/HTTP execution.' }, null, 2));
