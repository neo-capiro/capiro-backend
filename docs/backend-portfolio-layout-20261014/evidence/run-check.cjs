const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const [id, mode] = process.argv.slice(2);
if (!/^\d\d$/.test(id || '') || !['jest', 'types'].includes(mode)) throw new Error('exact attempt and check required');
function git(...args) { return cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }); }
const before = git('status', '--porcelain', '--untracked-files=all');
const boundPaths = [
  'apps/api/src/users/portfolio-layout.controller.ts', 'apps/api/src/users/portfolio-layout.transaction.ts',
  'apps/api/src/users/portfolio-layout.helpers.ts', 'apps/api/src/users/portfolio-layout.controller.spec.ts',
  'apps/api/src/users/portfolio-layout.module.spec.ts', 'apps/api/src/users/portfolio-layout.helpers.spec.ts',
  'apps/api/src/users/users.module.ts', 'apps/api/src/users/users.controller.ts',
  'apps/api/src/prisma/prisma.service.ts', 'apps/api/src/prisma/prisma.service.spec.ts',
  'apps/api/src/prisma/prisma-tenant-scope.spec.ts', 'apps/api/src/memory/memory-wall.helpers.ts',
  'apps/api/src/tenant/tenant-context.middleware.ts', 'apps/api/src/tenant/tenant.module.ts',
  'apps/api/src/auth/application-authority.ts', 'apps/api/src/auth/roles.guard.ts',
  'apps/api/prisma/schema.prisma', 'apps/api/prisma/migrations/20261014050000_user_portfolio_layout/migration.sql',
];
function bindings() { return boundPaths.map(file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })); }
const source = { head: git('rev-parse', 'HEAD').trim(), diffSha256: crypto.createHash('sha256').update(git('diff', 'HEAD')).digest('hex'), bindings: bindings(), status: before };
const args = mode === 'types'
  ? [path.join(root, 'apps/api/node_modules/typescript/bin/tsc'), '--project', path.join(__dirname, 'focused.tsconfig.json'), '--pretty', 'false']
  : [path.join(root, 'apps/api/node_modules/jest/bin/jest.js'), '--config', path.join(__dirname, 'focused.jest.cjs'), '--runInBand', '--json', '--outputFile', path.join(__dirname, `${id}-jest-result.json`)];
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: '/tmp', NODE_ENV: 'test',
  NODE_OPTIONS: `--require=${path.join(__dirname, 'source-refusal-preload.cjs')}` };
const result = cp.spawnSync(process.execPath, args, { cwd: root, env, encoding: null, maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
for (const stream of ['stdout', 'stderr']) {
  const data = result[stream] || Buffer.alloc(0);
  fs.writeFileSync(path.join(__dirname, `${id}-${mode}-${stream}.raw.lossless.json`), JSON.stringify({ originalFilename: `${id}-${mode}-${stream}.raw`, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), encoding: 'base64', data: data.toString('base64') }, null, 2) + '\n');
}
const after = git('status', '--porcelain', '--untracked-files=all');
const receipt = { id, mode, source, command: [process.execPath, ...args], exitCode: result.status, signal: result.signal, error: result.error && String(result.error),
  sourceDeltaUnchanged: crypto.createHash('sha256').update(git('diff', 'HEAD')).digest('hex') === source.diffSha256,
  boundSourcesUnchanged: JSON.stringify(bindings()) === JSON.stringify(source.bindings),
  note: 'Inert source ports and JavaScript refusal host; no native PostgreSQL, Clerk, migrations, deployed API, or runtime acceptance.' };
fs.writeFileSync(path.join(__dirname, `${id}-${mode}-receipt.json`), JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(JSON.stringify({ id, mode, exitCode: result.status, sourceDeltaUnchanged: receipt.sourceDeltaUnchanged, boundSourcesUnchanged: receipt.boundSourcesUnchanged }) + '\n');
if (result.status !== 0) process.stdout.write((result.stdout || Buffer.alloc(0)).toString() + (result.stderr || Buffer.alloc(0)).toString());
process.exitCode = result.status || (result.error || !receipt.sourceDeltaUnchanged || !receipt.boundSourcesUnchanged ? 1 : 0);
