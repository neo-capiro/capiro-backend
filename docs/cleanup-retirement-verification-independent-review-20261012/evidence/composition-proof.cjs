const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('/workspace/capirov2/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml');
const base = '5470c6df029c9553dd49e531229c3c91b26275ef';
const source = 'b877e03c5710bfc347568c7bbd1197f7caedbcde';
const root = '27755f153efc5b027eb37687540b428f910e8f11';
const engagement = 'e35d37ec080bbfbc5fccc0affe543af5b31fc1e2';
const outreach = '4060915ebfa55db4a8fb805c1e25281359c46a5d';
const bridge = '133c868ea596cccb05525d1249ddf32c97fe1a54';
const evidence = 'docs/cleanup-retirement-verification-independent-review-20261012/evidence/';
const git = (...args) => cp.execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const text = (...args) => git(...args).toString();
const read = (pin, path) => git('show', `${pin}:${path}`);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tree = pin => {
  const result = new Map();
  for (const row of text('ls-tree', '-r', '-z', pin).split('\0').filter(Boolean)) {
    const [entry, path] = row.split('\t');
    result.set(path, entry);
  }
  return result;
};
const groups = [
  [root, ['package.json', '.github/workflows/ci-pr.yml', 'scripts/ci/rebuild-verification-scopes.spec.mjs', 'scripts/ci/__fixtures__/rebuild-verification-frontend.job.yml']],
  [engagement, ['apps/api/scripts/engagement-phase1-qualification-plan.ts', 'apps/api/scripts/engagement-phase1-qualification-plan.spec.mjs', 'apps/api/scripts/verify-engagement-phase1-runtime.ts', 'scripts/engagement-phase3-qualification-plan.mjs', 'scripts/engagement-phase3-qualification-plan.spec.mjs', 'scripts/verify-engagement-phase2-code.mode.spec.mjs', 'scripts/verify-engagement-phase2-code.sh', 'scripts/verify-engagement-phase3-code.mjs']],
  [outreach, ['scripts/outreach-v3-qualification-plan.mjs', 'scripts/outreach-v3-qualification-plan.spec.mjs', 'scripts/verify-outreach-v3-phase1-code.mjs', 'scripts/verify-outreach-v3-phase3-code.mjs', 'scripts/verify-outreach-v3-phase4-code.mjs']],
  [bridge, ['apps/api/scripts/__fixtures__/engagement-current-ui-surface-manifest.v1.json', 'apps/api/scripts/engagement-phase3-read-materialization.spec.ts', 'apps/api/scripts/engagement-phase3-owned-fixture.spec.mjs']],
];
const before = tree(base), actual = tree(source), declared = new Set(groups.flatMap(([, paths]) => paths));
assert.equal(declared.size, 20);
const changed = [...new Set([...before.keys(), ...actual.keys()])].filter(path => before.get(path) !== actual.get(path));
assert.deepEqual(changed.filter(path => !path.startsWith('docs/')).sort(), [...declared].sort());
const sourceEntries = groups.flatMap(([owner, paths]) => paths.map(path => {
  const bytes = read(source, path);
  assert.equal(actual.get(path), tree(owner).get(path), path);
  assert.deepEqual(bytes, fs.readFileSync(path), `review tree source blob: ${path}`);
  return { path, owner, entry: actual.get(path), bytes: bytes.length, sha256: sha(bytes) };
}));
const protectedEntries = [...before].filter(([path]) => !declared.has(path));
for (const [path, entry] of protectedEntries) assert.equal(actual.get(path), entry, `protected path ${path}`);
const ancestors = [base, root, engagement, outreach, bridge, 'ec7261b0689bef2bcec1be3beb9af7754c12dc30'];
for (const ancestor of ancestors) git('merge-base', '--is-ancestor', ancestor, source);
const publishedProposalEntries = tree('8ac4c42cc49876ec19808369c0683956e0f2f474');
for (const path of groups[3][1]) assert.equal(actual.get(path), publishedProposalEntries.get(path), `exact published fixture seam ${path}`);

const originalPackage = JSON.parse(read(base, 'package.json'));
const currentPackage = JSON.parse(read(source, 'package.json'));
const inverse = structuredClone(currentPackage);
const addedAliases = Object.keys(currentPackage.scripts).filter(key => !Object.hasOwn(originalPackage.scripts, key));
assert.equal(Object.keys(originalPackage.scripts).length, 107);
assert.equal(addedAliases.length, 15);
for (const alias of addedAliases) delete inverse.scripts[alias];
assert.deepEqual(inverse, originalPackage);
assert.equal(currentPackage.scripts['gate:cleanup4:verification-scopes'], 'node --test scripts/ci/rebuild-verification-scopes.spec.mjs');
for (const alias of addedAliases.filter(key => key.startsWith('verify:'))) {
  const first = currentPackage.scripts[alias].split(' && ')[0];
  assert.equal((first.match(/(?:^|\s)--run(?:\s|$)/g) || []).length, 1, alias);
  assert.equal((first.match(/--(?:backend|frontend)-only/g) || []).length, 1, alias);
  assert(first.endsWith(alias.endsWith(':backend') ? '--backend-only' : '--frontend-only'));
}
const parsed = bytes => {
  const document = yaml.parseDocument(bytes.toString());
  assert.deepEqual(document.errors, []);
  return document.toJS();
};
const oldWorkflow = parsed(read(base, '.github/workflows/ci-pr.yml'));
const workflow = parsed(read(source, '.github/workflows/ci-pr.yml'));
const expectedWorkflow = structuredClone(oldWorkflow);
const steps = expectedWorkflow.jobs.verify.steps;
const typeIndex = steps.findIndex(step => step.name === 'Typecheck (turbo)');
assert(typeIndex >= 0);
steps[typeIndex] = { name: 'Typecheck backend workspaces (turbo)', run: 'pnpm typecheck:backend' };
steps.splice(typeIndex, 0, { name: 'Guard rebuild verification scope composition', run: 'pnpm gate:cleanup4:verification-scopes' });
const webIndex = steps.findIndex(step => step.name === 'Test apps/web');
assert(webIndex >= 0);
const originalWebStep = steps.splice(webIndex, 1)[0];
const phase1 = steps.find(step => step.name === 'Engagement API Phase 1 local-runtime contract');
assert(phase1);
phase1.run = 'pnpm verify:engagement-phase-1:backend';
const phase2 = expectedWorkflow.jobs['engagement-phase-2'].steps.find(step => step.name === 'Engagement API Phase 2 — code-complete verification (2.0-2.12)');
assert(phase2);
phase2.run = 'pnpm verify:engagement-phase-2:backend';
const frontendFixture = parsed(read(source, 'scripts/ci/__fixtures__/rebuild-verification-frontend.job.yml')).frontend;
expectedWorkflow.jobs.frontend = frontendFixture;
assert.deepEqual(workflow, expectedWorkflow);
assert.equal(Object.hasOwn(workflow.jobs.frontend, 'needs'), false);
assert.equal(Object.hasOwn(workflow.jobs.frontend, 'if'), false);
assert.deepEqual(workflow.jobs.frontend.steps.find(step => step.name === 'Test apps/web'), originalWebStep);
assert.equal(workflow.jobs.frontend['timeout-minutes'], 90);
assert.equal(workflow.jobs.frontend.env.NODE_OPTIONS, '--max-old-space-size=6144');
assert.deepEqual(workflow.jobs.frontend.steps.slice(0, 4), [
  { uses: 'actions/checkout@v4' }, { uses: 'pnpm/action-setup@v4' },
  { uses: 'actions/setup-node@v7', with: { 'node-version': 22, cache: 'pnpm' } },
  { run: 'pnpm install --frozen-lockfile' },
]);
for (const name of ['Test apps/api', 'Test apps/defense-api']) {
  const step = workflow.jobs.verify.steps.find(step => step.name === name);
  assert.deepEqual(step, oldWorkflow.jobs.verify.steps.find(step => step.name === name));
  assert.equal(step.if, "${{ toJSON(github.event.pull_request.draft) == 'false' }}");
}
const originalPublishedFrontend = read('8ac4c42cc49876ec19808369c0683956e0f2f474', '.github/workflows/ci-pr.yml').toString();
const oldWorkflowBytes = read(base, '.github/workflows/ci-pr.yml').toString();
const webStart = oldWorkflowBytes.indexOf('      # CleanUp1 §5.3.2');
const webEnd = oldWorkflowBytes.indexOf('      # CleanUp1 §5.3.3', webStart);
assert(webStart > 0 && webEnd > webStart);
const oldWebStepBytes = oldWorkflowBytes.slice(webStart, webEnd);
const proposalFrontend = originalPublishedFrontend.slice(originalPublishedFrontend.indexOf('\n  frontend:\n'));
const frontendAnchor = '      - name: Engagement Phase1 retained frontend regression and routing contract';
assert.equal(proposalFrontend.split(frontendAnchor).length, 2);
assert.equal(read(source, 'scripts/ci/__fixtures__/rebuild-verification-frontend.job.yml').toString(), proposalFrontend.replace(frontendAnchor, oldWebStepBytes + frontendAnchor));
const rootGuard = read(source, 'scripts/ci/rebuild-verification-scopes.spec.mjs').toString();
assert.equal(rootGuard.includes('8ac4c42'), false);
assert.equal(rootGuard.includes('const proposed ='), false); // no former foreign-object helper
assert.equal(actual.get('pnpm-workspace.yaml'), before.get('pnpm-workspace.yaml'));
const originalFixture = 'apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json';
const newFixture = 'apps/api/scripts/__fixtures__/engagement-current-ui-surface-manifest.v1.json';
assert.deepEqual(read(source, newFixture), read(base, originalFixture));
assert.equal(actual.get(originalFixture), before.get(originalFixture));
const readerPath = 'apps/api/scripts/engagement-phase3-read-materialization.spec.ts';
const oldLiteral = '../../web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json';
const newLiteral = '__fixtures__/engagement-current-ui-surface-manifest.v1.json';
const reader = read(source, readerPath).toString();
assert.equal(reader.split("'" + newLiteral + "'").length, 2);
assert.equal(reader.includes(oldLiteral), false);
assert.equal(reader.replace("'" + newLiteral + "'", "'" + oldLiteral + "'"), read(base, readerPath).toString());
const fixture = JSON.parse(read(source, newFixture));
assert.equal(fixture.requests.length, 237);
assert.equal(fixture.routeCoverage.length, 129);
const result = {
  source, tree: text('rev-parse', `${source}^{tree}`).trim(), base, baseTree: text('rev-parse', `${base}^{tree}`).trim(),
  componentAncestors: ancestors, sourceEntries, declaredNonDocOverlay: 20,
  protectedBaselineEntries: protectedEntries.length,
  protectedBaselineDocs: protectedEntries.filter(([path]) => path.startsWith('docs/')).length,
  protectedFrontendEntries: protectedEntries.filter(([path]) => path.startsWith('apps/web/') || path.startsWith('apps/onboard-web/')).length,
  protectedSchemaAndMigrationEntries: protectedEntries.filter(([path]) => path.endsWith('/schema.prisma') || path.includes('/migrations/')).length,
  protectedSharedEntries: protectedEntries.filter(([path]) => path.startsWith('packages/shared/')).length,
  protectedAllOtherBaseEntries: 'mode/type/blob equality; no protected reporting body read',
  rootPackageOriginalAliases: 107, newAliases: addedAliases,
  parsedWorkflowExactHunkUnion: true, frontendIndependent: true, oldApiDefenseDraftConditionsExact: true,
  checkedInFrontendFixturePublishedJobPlusExactMovedDestinationWebBytes: true, permanentGuardNeedsOnlyAncestor547: true,
  sourceFixtureCopiedCurrentDestination: true, fixtureRequests: 237, fixtureRoutes: 129, currentReaderSingleLiteralInverseExact: true,
  cache: { node: process.version, yaml: '/workspace/capirov2/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml' },
  executed: 'read-only Git/tree/JSON/YAML and byte/mode assertions only', actualVerifierAppBuildNativeDbSqlProviderCiCalls: 0,
};
fs.writeFileSync(evidence + 'composition-proof.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source, tree: result.tree, sourcePaths: 20, protectedBaselineEntries: result.protectedBaselineEntries, originalAliases: 107, parsedCIExact: true, fixtureRelocationExact: true }));
