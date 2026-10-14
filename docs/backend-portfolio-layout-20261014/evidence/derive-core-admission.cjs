// Parse-only correction of the original wrapper's uppercase/lowercase comparison.
// This script does not invoke a runtime, test, database, provider or generator.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const sourceHead = '078c55f805de8599cc413917ef90b7e20f040942';
const sourceTree = 'e7dfea58d4044cd0b26bc1c13b5fda8c17e1522a';
const root = path.resolve(__dirname, '../../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 2 * 1024 * 1024 });
function payload(file) {
  const bytes = fs.readFileSync(path.join(__dirname, file)), value = JSON.parse(bytes);
  const original = Buffer.from(value.data, 'base64');
  if (value.encoding !== 'base64' || original.length !== value.bytes || hash(original) !== value.sha256) throw new Error(`lossless mismatch ${file}`);
  return { bytes, original, receipt: { file, bytes: bytes.length, sha256: hash(bytes), originalBytes: original.length, originalSha256: value.sha256 } };
}
const stdout = payload('combined-core-stdout.lossless.json'), stderr = payload('combined-core-stderr.lossless.json');
const originalBytes = fs.readFileSync(path.join(__dirname, 'combined-core-receipt.json'));
const original = JSON.parse(originalBytes), marker = 'QUALIFICATION_REPORT\n', text = stdout.original.toString(), offset = text.lastIndexOf(marker);
if (offset < 0) throw new Error('missing raw qualification report');
const report = JSON.parse(text.slice(offset + marker.length));
const harnessBytes = git('show', `${sourceHead}:${original.harness.path}`);
const harnessBlob = git('rev-parse', `${sourceHead}:${original.harness.path}`).toString().trim();
if (!harnessBytes.toString().includes('methods: Object.keys(x.route.methods)')) throw new Error('method representation not bound');
const sourceSchemaSha256 = hash(git('show', `${sourceHead}:apps/api/prisma/schema.prisma`));
const loadedBindings = ['apps/api/src/users/portfolio-layout.controller.ts', 'apps/api/src/users/users.module.ts'].map(file => {
  const row = report.sourceRows.find(value => value.path === file);
  const blob = git('rev-parse', `${sourceHead}:${file}`).toString().trim(), sourceSha256 = hash(git('show', `${sourceHead}:${file}`));
  return { path: file, blob, sourceSha256, loadedExact: !!row && row.blob === blob && row.sourceSha256 === sourceSha256 };
});
const routes = ['get', 'put'].map(method => ({ method, path: '/api/me/portfolio-layout',
  passed: report.routes.some(row => row.path === '/api/me/portfolio-layout' && row.methods.includes(method)) }));
const checks = [
  { name: 'exact combined source head/tree and original exit0', passed: original.sourceHead === sourceHead && original.sourceTree === sourceTree && report.sourceHead === sourceHead && report.sourceTree === sourceTree && original.exitCode === 0 && git('rev-parse', `${sourceHead}^{tree}`).toString().trim() === sourceTree },
  { name: 'original wrapper HELD retained with its two case-mismatch refusals', passed: original.result === 'held' && original.checks.filter(row => row.passed === false).length === 2 && original.checks.filter(row => row.passed === false).every(row => /^registered (GET|PUT) \/api\/me\/portfolio-layout$/.test(row.name)) },
  { name: 'raw Core report pass with all28 original checks', passed: report.result === 'pass' && report.checks.length === 28 && report.checks.every(row => row.passed === true) },
  { name: 'original harness blob/hash exact at combined source', passed: harnessBlob === original.harness.blob && hash(harnessBytes) === original.harness.sha256 },
  ...routes.map(row => ({ name: `registered ${row.method} ${row.path} from actual lowercase method keys`, passed: row.passed })),
  ...loadedBindings.map(row => ({ name: `real source loaded ${row.path}`, passed: row.loadedExact })),
  { name: 'no unexpected denied I/O, async errors or remaining timers', passed: report.denied.length === 0 && report.asyncErrors.length === 0 && report.remainingTimers.length === 0 },
  { name: 'authored/cache schema hashes exact and explicitly different', passed: sourceSchemaSha256 === original.sourceSchemaSha256 && report.cachedPrismaSchemaSha256 === original.cachedPrismaSchemaSha256 && sourceSchemaSha256 !== report.cachedPrismaSchemaSha256 },
];
const result = { sourceHead, sourceTree, result: checks.every(row => row.passed) ? 'pass' : 'held',
  derivation: 'Parse-only observation correction: original wrapper compared uppercase GET/PUT to existing lowercase Object.keys(route.methods). No runtime/check rerun or original report mutation.',
  inputs: [stdout.receipt, stderr.receipt, { file: 'combined-core-receipt.json', bytes: originalBytes.length, sha256: hash(originalBytes) },
    ...['run-combined-core.cjs', 'derive-core-admission.cjs'].map(file => { const bytes = fs.readFileSync(path.join(__dirname, file)); return { file, bytes: bytes.length, sha256: hash(bytes) }; })],
  harness: original.harness, loadedBindings, sourceSchemaSha256, cachedPrismaSchemaSha256: report.cachedPrismaSchemaSha256,
  schemaQualification: original.schemaQualification, checks, routes,
  summary: original.summary, qualification: original.qualification,
  limits: ['Actual source Core init/close and registered-route metadata only; no native PostgreSQL/RLS/SSI/row-lock/pool acceptance',
    'Cached generated Prisma namespace intentionally predates authored layout model; no generation or migration executed',
    'No provider/live-session/customer write/process restart/deployed image acceptance or runtime retirement'],
};
const destination = path.join(__dirname, 'derived-core-admission-receipt.json');
if (process.argv[2] === '--write') fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
else if (JSON.stringify(JSON.parse(fs.readFileSync(destination))) !== JSON.stringify(result)) throw new Error('derived receipt differs from exact inputs');
console.log(JSON.stringify({ result: result.result, checks: checks.length, sourceHead, routes }));
if (result.result !== 'pass') process.exitCode = 1;
