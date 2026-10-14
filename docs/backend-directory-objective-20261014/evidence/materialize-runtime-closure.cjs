const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const tracked = new Set(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n'));
const entries = ['apps/api/src/clients/client-targets.controller.ts', 'apps/api/src/clients/client-targets.service.spec.ts',
  'apps/api/src/clients/client-targets.objective-destination.spec.ts', 'apps/api/src/clients/client-targets.objective-destination.controller.spec.ts',
  'apps/api/src/clients/objectives/objective-destination.shared.spec.ts'];
const seen = new Set(), queue = [...entries], missing = [];
while (queue.length) {
  const file = queue.shift(); if (seen.has(file)) continue; seen.add(file);
  const absolute = path.join(root, file);
  const source = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : git('show', `HEAD:${file}`);
  const code = ts.transpileModule(source, { fileName: file, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true, useDefineForClassFields: false,
  } }).outputText;
  for (const match of code.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, path.posix.join(base, 'index.ts')];
    const target = candidates.find((candidate) => tracked.has(candidate) || fs.existsSync(path.join(root, candidate)));
    if (!target) missing.push({ file, request: match[1] }); else queue.push(target);
  }
}
if (missing.length) throw new Error(JSON.stringify(missing));
const requested = [...seen, 'apps/api/src/clients/clients.module.ts', 'apps/api/src/app.module.ts'].filter((file) => tracked.has(file));
fs.writeFileSync(path.join(__dirname, 'runtime-closure.json'), JSON.stringify({ sourceHead: git('rev-parse', 'HEAD').trim(), entries, files: requested }, null, 2) + '\n');
const result = cp.spawnSync('git', ['sparse-checkout', 'add', '--stdin'], { cwd: root, encoding: 'utf8', input: requested.map((file) => `/${file}`).join('\n') + '\n' });
if (result.status) throw new Error(result.stderr);
process.stdout.write(JSON.stringify({ materialized: requested.length }) + '\n');
