// Materialize only exact candidate runtime imports for the focused synthetic unit suite.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const head = 'de6d6e1abeb1c8e4c4ed3bcb30bde3a8ac48975d';
const git = (...args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const files = new Map(git('ls-tree', '-rz', '--full-tree', head).toString().split('\0').filter(Boolean).map((line) => {
  const [info, name] = line.split('\t'); return [name, info.split(' ')[2]];
}));
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const rows = [], visited = new Set();
function visit(name) {
  if (visited.has(name)) return;
  visited.add(name);
  if (name === 'apps/api/src/engagement/engagement.service.ts') throw new Error('UNIT_PROTECTED_BODY_REFUSED');
  const blob = files.get(name); if (!blob) throw new Error(`UNBOUND_SOURCE:${name}`);
  const bytes = git('cat-file', 'blob', blob), target = path.join(root, name);
  if (fs.existsSync(target) && !fs.readFileSync(target).equals(bytes)) throw new Error(`EXISTING_SOURCE_DIFFERS:${name}`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  rows.push({ path: name, blob, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  const tree = ts.createSourceFile(name, bytes.toString(), ts.ScriptTarget.Latest, true);
  for (const node of tree.statements) {
    if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || node.isTypeOnly || node.importClause?.isTypeOnly) continue;
    if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)) continue;
    const spec = node.moduleSpecifier?.text;
    if (typeof spec !== 'string' || !spec.startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec));
    const next = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`].find((item) => files.has(item));
    if (!next || !next.startsWith('apps/api/src/')) throw new Error(`IMPORT_NOT_BOUND:${name}:${spec}`);
    visit(next);
  }
}
visit('apps/api/src/context/meetings-context-plane.runtime.spec.ts');
process.stdout.write(JSON.stringify({ head, qualification: 'Focused unit runtime imports only; exact source hydration, no compile/native/database/provider run', rows }, null, 2) + '\n');
