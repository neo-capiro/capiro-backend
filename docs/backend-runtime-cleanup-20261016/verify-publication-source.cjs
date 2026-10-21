const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Use exactly --run for the one-time publication source proof; this is not current CI.');
const root = path.resolve(__dirname, '../..');
const packet = 'docs/backend-runtime-cleanup-20261016';
const parent = '7b6bda7ca75ea86afb36c76f013f550fdd79e42f';
const git = (...args) => execFileSync('git', args, { cwd: root, timeout: 30000,
  maxBuffer: 4 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] });
const sha = b => createHash('sha256').update(b).digest('hex');
const head = git('rev-parse', 'HEAD').toString().trim();
assert.equal(git('rev-parse', 'cleanup/backend-only-workspace-20261016').toString().trim(), parent);
const changed = git('diff', '--no-renames', '--name-only', parent, head).toString().trim().split('\n').filter(Boolean);
const application = changed.filter(file => /^(?:apps|packages)\//.test(file));
assert.deepEqual(application.sort(), ['apps/api/src/directory/directory-detail-mappers.ts', 'apps/api/src/directory/directory.service.ts']);
const protectedTrees = [
  'apps/api/prisma', 'packages', 'apps/defense-api', 'apps/intel-api', 'apps/api-strategy',
  'apps/onboard-api', 'apps/onboard-web', 'apps/e2e', '.github',
  'apps/api/src/auth', 'apps/api/src/tenant', 'apps/api/src/memory',
  'apps/api/src/research-portfolios', 'apps/api/src/clients/objectives',
  'apps/api/src/engagement', 'apps/api/src/app.module.ts',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'scripts/engagement-phase3-preview-route-patterns.mjs',
  'tests/support/legacy-web/SOURCE-INPUTS.json',
  'tests/support/legacy-web/source-inputs',
  'docs/backend-cleanup-20261016', 'docs/backend-cleanup-frontend-20261016',
];
const protectedIdentities = protectedTrees.map(file => {
  const before = git('ls-tree', parent, '--', file).toString().trim();
  const after = git('ls-tree', head, '--', file).toString().trim();
  assert.equal(after, before, 'Protected tree/blob drift: '+file);
  return { path: file, gitTreeEntry: before || 'absent at parent and successor' };
});
const status = JSON.parse(git('show', `${head}:${packet}/evidence/plan-status-prefaces.json`));
const originalPlans = status.rows.map(row => {
  const old = git('show', `${parent}:${row.path}`);
  const now = git('show', `${head}:${row.path}`);
  assert.equal(sha(old), row.beforeSHA256);
  assert.equal(sha(now), row.afterSHA256);
  assert(now.subarray(row.prefixBytes).equals(old), 'Historical plan body changed: '+row.path);
  return { path: row.path, originalBodyBytes: old.length, prefixBytes: row.prefixBytes, inverse: 'exact' };
});
const inventoryPath = 'scripts/engagement-phase3-ui-inventory.spec.mjs';
const oldInventory = git('show', `${parent}:${inventoryPath}`).toString();
const newInventory = git('show', `${head}:${inventoryPath}`).toString();
const caseNames = source => [...source.matchAll(/\btest\('((?:\\.|[^'])*)'/g)].map(match => match[1]);
assert.equal(caseNames(oldInventory).length, 32);
assert.deepEqual(caseNames(newInventory), caseNames(oldInventory));
assert.equal((newInventory.match(/\bassert\./g) ?? []).length, (oldInventory.match(/\bassert\./g) ?? []).length);
const visualPath = 'scripts/cleanup-script-smoke/web-visual-cli-controls.mjs';
const oldVisual = git('show', `${parent}:${visualPath}`).toString();
const newVisual = git('show', `${head}:${visualPath}`).toString();
const bodyMarker = 'const TEMP = path.resolve(os.tmpdir());';
assert(oldVisual.includes(bodyMarker) && newVisual.includes(bodyMarker));
assert.equal(newVisual.slice(newVisual.indexOf(bodyMarker)), oldVisual.slice(oldVisual.indexOf(bodyMarker)));
const rawPaths = git('ls-tree', '-r', '--name-only', head, '--', `${packet}/evidence`).toString().trim().split('\n').filter(Boolean);
const capturedGitBytes = rawPaths.map(file => {
  const bytes = git('show', `${head}:${file}`);
  assert(fs.readFileSync(path.join(root,file)).equals(bytes), 'Captured bytes changed on checkout: '+file);
  return { path: file, bytes: bytes.length, sha256: sha(bytes) };
});
const count = JSON.parse(fs.readFileSync(path.join(root, packet, 'CODE-COUNTS.json')));
assert.equal(git('diff', count.sourceHead, head, '--', 'apps', 'packages', 'scripts', 'tests', 'infra', 'evals', 'docker').length, 0,
  'Source changed after count checkpoint');
const report = { sourceHead: head, parent, changedPaths: changed, applicationPaths: application,
  protectedIdentities, originalPlans, capturedGitBytes,
  historicalInventoryCaseNames: caseNames(newInventory), historicalInventoryAssertionCountUnchanged: true,
  historicalVisualBodyUnchanged: true,
  countedSourceHead: count.sourceHead, countedFirstPartySourceUnchanged: true,
  sealedPR30LocalRefUnchanged: true,
  limits: 'Finite Git source/capture proof only; no native/build/install/browser/image/runtime/deployment qualification. Remote publication is checked separately.' };
fs.writeFileSync(path.join(root, packet, 'PUBLICATION-SOURCE-PROOF.json'), JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ sourceHead:head, parent, changedPaths:changed.length,
  applicationPaths:application, protectedIdentities:protectedIdentities.length,
  historicalPlanInverses:originalPlans.length, capturedGitBytes:capturedGitBytes.length,
  countedSourceHead:count.sourceHead, countedFirstPartySourceUnchanged:true },null,2));
