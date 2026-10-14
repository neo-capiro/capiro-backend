const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const [id, mode] = process.argv.slice(2);
if (!/^\d\d$/.test(id || '') || !['baseline', 'jest', 'types'].includes(mode)) throw new Error('Exact check attempt/mode required');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 3 * 1024 * 1024 });
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const boundPaths = ['apps/api/src/clients/client-targets.controller.ts', 'apps/api/src/clients/client-targets.service.ts',
  'apps/api/src/clients/client-targets.service.spec.ts', 'apps/api/src/clients/client-targets.objective-destination.spec.ts',
  'apps/api/src/clients/client-targets.objective-destination.controller.spec.ts', 'apps/api/src/clients/objectives/objective-destination.ts',
  'apps/api/src/clients/objectives/objective-destination.shared.spec.ts', 'apps/api/src/clients/clients.module.ts', 'apps/api/src/app.module.ts',
  'apps/api/src/tenant/tenant-context.middleware.ts', 'apps/api/src/auth/roles.guard.ts'];
const bindings = () => boundPaths.map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
const head = git('rev-parse', 'HEAD').trim(), before = bindings();
const args = mode === 'types' ? [path.join(__dirname, 'check-source-types.cjs')]
  : [path.join(root, 'apps/api/node_modules/jest/bin/jest.js'), '--config', path.join(__dirname, 'focused.jest.cjs'), '--runInBand', '--json', '--outputFile', path.join(__dirname, `${id}-jest-result.json`),
    ...(mode === 'baseline' ? ['--runTestsByPath', path.join(root, 'apps/api/src/clients/client-targets.service.spec.ts'), path.join(root, 'apps/api/src/clients/objectives/objective-destination.shared.spec.ts')] : [])];
const preload = mode === 'baseline' ? path.join(__dirname, 'baseline-refusal-preload.cjs') : path.join(__dirname, 'source-refusal-preload.cjs');
const tmpdir = path.join(root, '.qualification-cache/directory-tmp');
fs.mkdirSync(tmpdir, { recursive: true });
if (fs.realpathSync(tmpdir) !== tmpdir) throw new Error('Owned temporary directory required');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir, NODE_ENV: 'test', ...(mode === 'types' ? {} : { NODE_OPTIONS: `--require=${preload}` }) };
const result = cp.spawnSync(process.execPath, args, { cwd: root, env, encoding: null, maxBuffer: 5 * 1024 * 1024, timeout: 120000 });
for (const stream of ['stdout', 'stderr']) {
  const data = result[stream] || Buffer.alloc(0);
  fs.writeFileSync(path.join(__dirname, `${id}-${mode}-${stream}.raw.lossless.json`), JSON.stringify({ encoding: 'base64', originalFilename: `${id}-${mode}-${stream}.raw`, bytes: data.length, sha256: hash(data), data: data.toString('base64') }, null, 2) + '\n');
}
const unchanged = JSON.stringify(before) === JSON.stringify(bindings());
fs.writeFileSync(path.join(__dirname, `${id}-${mode}-receipt.json`), JSON.stringify({ id, mode, head, boundPaths: before,
  command: [process.execPath, ...args], tmpdir, exitCode: result.status, signal: result.signal, error: result.error && String(result.error), boundSourcesUnchanged: unchanged,
  qualification: 'Source/synthetic owner/controller/native-middleware IO-port fixture and narrow strict types only; no full ClientsModule/Core boot, native PostgreSQL/RLS, real Clerk/provider, migration or live HTTP acceptance.' }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ id, mode, exitCode: result.status, boundSourcesUnchanged: unchanged }) + '\n');
if (result.status || !unchanged) process.stdout.write((result.stdout || Buffer.alloc(0)).toString() + (result.stderr || Buffer.alloc(0)).toString());
process.exitCode = result.status || (result.error || !unchanged ? 1 : 0);
