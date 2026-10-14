// Hydrate only actual emitted runtime imports, including original real factories.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const git = (...args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const manifest = new Map(git('ls-tree', '-rz', '--full-tree', head).toString().split('\0').filter(Boolean).map(line => {
  const [info, file] = line.split('\t'); const [mode, kind, blob] = info.split(' '); return [file, { mode, kind, blob }];
}));
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const rows = [], seen = new Set();
function visit(file) {
  if (seen.has(file)) return; seen.add(file);
  if (file === 'apps/api/src/engagement/engagement.service.ts') throw new Error('RUNTIME_PUBLISHED_ENGAGEMENT_BODY_UNNEEDED');
  const meta = manifest.get(file); if (!meta || meta.mode !== '100644' || meta.kind !== 'blob') throw new Error(`source not bound ${file}`);
  const target = path.join(root, file), committed = git('cat-file', 'blob', meta.blob);
  // The two allocated source/spec paths may be under preparation before their freeze.
  const allocated = ['apps/api/src/context/meetings-context-plane.runtime.ts', 'apps/api/src/context/meetings-context-plane.runtime.spec.ts'].includes(file);
  const bytes = allocated && fs.existsSync(target) ? fs.readFileSync(target) : committed;
  if (fs.existsSync(target) && !allocated && !fs.readFileSync(target).equals(committed)) throw new Error(`foreign source changed ${file}`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  rows.push({ path: file, blob: meta.blob, workingSha256: crypto.createHash('sha256').update(bytes).digest('hex'), committedExact: bytes.equals(committed), bytes: bytes.length });
  const emitted = ts.transpileModule(bytes.toString(), { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true, useDefineForClassFields: false,
  } }).outputText;
  const tree = ts.createSourceFile(file + '.js', emitted, ts.ScriptTarget.Latest, true);
  function walk(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const spec = node.arguments[0].text;
      if (spec.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        const next = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`].find(value => manifest.has(value));
        if (!next || !next.startsWith('apps/api/src/')) throw new Error(`unbound import ${file}:${spec}`);
        visit(next);
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(tree);
}
visit('apps/api/src/context/meetings-context-plane.runtime.spec.ts');
process.stdout.write(JSON.stringify({ head, rows, qualification: 'Exact original source runtime imports hydrated; two allocated working source paths explicitly labelled, no execution/native/provider/DB.' }, null, 2) + '\n');
