const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const root = '/workspace/capiro-backend-boundary-successor-20261014';
const sourceHead = '078c55f805de8599cc413917ef90b7e20f040942';
const sourceTree = 'e7dfea58d4044cd0b26bc1c13b5fda8c17e1522a';
const harness = 'docs/backend-core-source-startup-20261014/check-core-startup.cjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
if (git('rev-parse', `${sourceHead}^{tree}`).toString().trim() !== sourceTree) throw new Error('source tree mismatch');
if (git('status', '--porcelain', '--', harness).length) throw new Error('fixture modified');
const args = [path.join(root, harness), `--source-head=${sourceHead}`, `--source-tree=${sourceTree}`];
const result = cp.spawnSync(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
for (const stream of ['stdout', 'stderr']) {
  const bytes = result[stream] || Buffer.alloc(0);
  fs.writeFileSync(path.join(__dirname, `combined-core-${stream}.lossless.json`), JSON.stringify({ encoding: 'base64', bytes: bytes.length, sha256: hash(bytes), data: bytes.toString('base64') }, null, 2) + '\n');
}
const output = (result.stdout || Buffer.alloc(0)).toString();
const marker = 'QUALIFICATION_REPORT\n';
const index = output.lastIndexOf(marker);
let report, parseError;
try { if (index < 0) throw new Error('missing qualification report'); report = JSON.parse(output.slice(index + marker.length)); }
catch (error) { parseError = error.message; }
const schema = git('show', `${sourceHead}:apps/api/prisma/schema.prisma`);
const checks = report ? [
  { name: 'combined exact source head and tree', passed: report.sourceHead === sourceHead && report.sourceTree === sourceTree },
  { name: 'real Core module qualification pass', passed: report.result === 'pass' && result.status === 0 },
  ...['GET', 'PUT'].map(method => ({ name: `registered ${method} /api/me/portfolio-layout`, passed: report.routes.some(row => row.path === '/api/me/portfolio-layout' && row.methods.includes(method)) })),
  { name: 'registered real layout controller source loaded', passed: report.sourceRows.some(row => row.path === 'apps/api/src/users/portfolio-layout.controller.ts') },
  { name: 'registered existing UsersModule source loaded', passed: report.sourceRows.some(row => row.path === 'apps/api/src/users/users.module.ts') },
  { name: 'no unexpected denied I/O or asynchronous errors', passed: !report.denied.length && !report.asyncErrors.length && !report.remainingTimers.length },
] : [];
const receipt = {
  sourceHead, sourceTree, harness: { path: harness, blob: git('rev-parse', `HEAD:${harness}`).toString().trim(), sha256: hash(fs.readFileSync(path.join(root, harness))) },
  command: [process.execPath, ...args], exitCode: result.status, signal: result.signal, error: result.error?.message, parseError,
  sourceSchemaSha256: hash(schema), cachedPrismaSchemaSha256: report?.cachedPrismaSchemaSha256,
  schemaQualification: 'The authored schema is intentionally newer than the unchanged cached Prisma namespace. No generation, migration, database or RLS execution. Layout uses raw SQL; graph initialization proves source/DI registration only.',
  checks, result: checks.length && checks.every(row => row.passed) ? 'pass' : 'held',
  summary: report && { loadedSources: report.sourceRows.length, modules: report.modules.length, routes: report.routes.length, coreChecks: report.checks.length, expectedSdkPrewarmDenials: report.events.filter(row => row.expectedDenial).length },
  qualification: report?.qualification,
};
fs.writeFileSync(path.join(__dirname, 'combined-core-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(JSON.stringify(receipt) + '\n');
process.exitCode = receipt.result === 'pass' ? 0 : 1;
