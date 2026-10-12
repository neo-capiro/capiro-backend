import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { declarationDigest, run } from '../../../scripts/check-registry-ownership.mjs';
import { inspectHelperInventory } from '../../../scripts/check-duplicate-helpers.mjs';

const require = createRequire(import.meta.url);
const yaml = require('/workspace/capirov2/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml');
const source = '7ea444c74a5637577aa0eb3cb99cb420b5f8223e';
const base = cp.execFileSync('git', ['rev-parse', '74d04937d'], { encoding: 'utf8' }).trim();
const author = 'd3e0efacf59fb64361c612c01da5ae8a6f19e426';
const out = 'docs/cleanup-meri-local-dispatch-independent-review-20261012/evidence/';
const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const bytes = (sha, path) => cp.execFileSync('git', ['show', `${sha}:${path}`]);
const text = (sha, path) => bytes(sha, path).toString();
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const entries = sha => new Map(git('ls-tree', '-r', sha).trim().split('\n').map(line => {
  const tab = line.indexOf('\t'); return [line.slice(tab + 1), line.slice(0, tab)];
}));
const app = ['apps/api/src/meri/meri-tools.service.ts', 'apps/api/src/meri/meri-local-dispatch.ts', 'apps/api/src/meri/meri-local-dispatch.equivalence.spec.ts'];
const root = ['scripts/registry-ownership.json', 'scripts/duplicate-helper-names.txt', 'package.json', '.github/workflows/ci-pr.yml'];
const paths = [...app, ...root].sort();
assert.deepEqual(git('diff', '--name-only', base, source).trim().split('\n').filter(p => !p.startsWith('docs/')).sort(), paths);
const beforeEntries = entries(base), afterEntries = entries(source), authorEntries = entries(author);
for (const path of app) {
  assert.equal(afterEntries.get(path), authorEntries.get(path));
  assert(fs.readFileSync(path).equals(bytes(source, path)));
}
let protectedPaths = 0, protectedApps = 0, schemasAndMigrations = 0, priorDocuments = 0;
for (const [path, entry] of beforeEntries) {
  if (paths.includes(path)) continue;
  assert.equal(afterEntries.get(path), entry, path);
  protectedPaths++;
  if (path.startsWith('apps/')) protectedApps++;
  if (/(?:schema\.prisma$|\/migrations\/)/.test(path)) schemasAndMigrations++;
  if (path.startsWith('docs/')) priorDocuments++;
}
for (const p of [source, author]) assert.equal(cp.spawnSync('git', ['merge-base', '--is-ancestor', p, 'HEAD']).status, 0);
const priorData = JSON.parse(text(base, root[0])), data = JSON.parse(text(source, root[0]));
assert.deepEqual({ ...data, profiles: data.profiles.slice(0, -1) }, priorData);
assert.equal(data.profiles.length, 5);
const profile = data.profiles.at(-1);
assert.equal(profile.id, 'meri-local-core-dispatch');
assert.equal(profile.owner, app[1]);
assert.deepEqual(profile.roots, ['apps/api/src']);
assert.deepEqual(profile.symbols, [
  { name: 'executeMeriLocalDispatch', kind: 'function' },
  { name: 'MeriLocalToolName', kind: 'type' },
  { name: 'MeriLocalDispatchRegistry', kind: 'type' },
]);
assert.deepEqual(profile.edges, [{ file: app[0], module: './meri-local-dispatch.js', imported: 'executeMeriLocalDispatch', uses: 1 }]);
assert.deepEqual(profile.carriers.map(({ file, name, kind }) => ({ file, name, kind })), [
  { file: app[1], name: 'executeMeriLocalDispatch', kind: 'function' },
  { file: app[1], name: 'MeriLocalToolName', kind: 'type' },
  { file: app[1], name: 'MeriLocalDispatchRegistry', kind: 'type' },
  { file: app[0], name: 'MeriToolsService', kind: 'class' },
  { file: app[0], name: 'assertNever', kind: 'function' },
]);
for (const carrier of profile.carriers) assert.equal(declarationDigest(fs.readFileSync(carrier.file, 'utf8'), carrier.name, carrier.kind, carrier.file), carrier.sha256);
const oldInventory = text(base, root[1]), inventory = text(source, root[1]);
assert.equal(inventory, oldInventory + 'meri-local-core-dispatch\texecuteMeriLocalDispatch\n');
assert.equal(oldInventory.split('\n').filter(row => row && !row.startsWith('#')).length, 6);
assert.deepEqual(inspectHelperInventory(data, inventory), { errors: [], helpers: 7 });
const oldPackage = JSON.parse(text(base, root[2])), pkg = JSON.parse(text(source, root[2]));
const alias = 'gate:cleanup4:meri-local-dispatch';
assert.equal(pkg.scripts[alias], 'pnpm --filter @capiro/api exec jest --config ../../scripts/cleanup-runtime-equivalence.jest.cjs --runInBand --runTestsByPath src/meri/meri-local-dispatch.equivalence.spec.ts');
const oldValue = { ...pkg, scripts: { ...pkg.scripts } }; delete oldValue.scripts[alias];
assert.deepEqual(oldValue, oldPackage);
const priorCiText = text(base, root[3]), ciText = text(source, root[3]);
const inserted = '      - name: Test reviewed Meri local dispatch\n        run: pnpm gate:cleanup4:meri-local-dispatch\n\n';
assert.equal(ciText.split(inserted).length, 2);
assert.equal(ciText.replace(inserted, ''), priorCiText);
const oldCi = yaml.parse(priorCiText), ci = yaml.parse(ciText);
let step, jobName;
for (const [name, job] of Object.entries(ci.jobs)) {
  const matches = job.steps?.filter(s => s.name === 'Test reviewed Meri local dispatch') ?? [];
  if (matches.length) { assert.equal(matches.length, 1); step = matches[0]; jobName = name; }
}
assert.deepEqual(step, { name: 'Test reviewed Meri local dispatch', run: `pnpm ${alias}` });
const copy = structuredClone(ci); copy.jobs[jobName].steps = copy.jobs[jobName].steps.filter(s => s.name !== step.name);
assert.deepEqual(copy, oldCi);
assert(ci.jobs[jobName].steps.findIndex(s => s.name === 'Test reviewed Meri local dispatch') > ci.jobs[jobName].steps.findIndex(s => /install/i.test(s.name ?? '') || /pnpm install/.test(s.run ?? '')));
assert(fs.existsSync('scripts/cleanup-runtime-equivalence.jest.cjs'));
assert.equal(afterEntries.get('scripts/cleanup-runtime-equivalence.jest.cjs'), beforeEntries.get('scripts/cleanup-runtime-equivalence.jest.cjs'));
const current = run(); assert.equal(current.errors.length, 0); assert.equal(current.profiles, 5); assert.equal(current.files, 2199);
const result = {
  source, tree: git('rev-parse', `${source}^{tree}`).trim(), base, baseTree: git('rev-parse', `${base}^{tree}`).trim(), author,
  nonDocumentDelta: paths.map(path => ({ path, baseEntry: beforeEntries.get(path) ?? null, sourceEntry: afterEntries.get(path), sha256: digest(bytes(source, path)) })),
  originalAuthorApplicationBlobsAndModesExact: app,
  protectedPaths, protectedApps, schemasAndMigrations, priorDocuments,
  otherFourProfilesExact: true, carrierDigestsVerified: profile.carriers, priorSixInventoryRowsByteExact: true,
  inventory: inspectHelperInventory(data, inventory),
  onlyPackageChangeOneAlias: alias, onlyCiChangeOneUnconditionalStep: { jobName, ...step },
  allOriginalCiValuesAndTextExact: true, existingNativeDraftConditionsUnchanged: true, existingDependencyOrderingPreserved: true,
  currentInspection: current, cachedYamlVersion: '2.9.1', applicationModulesImported: false,
  pnpmAliasOrCiExecuted: false, nativeAcceptance: false,
};
fs.writeFileSync(out + 'adoption-wiring-review.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
