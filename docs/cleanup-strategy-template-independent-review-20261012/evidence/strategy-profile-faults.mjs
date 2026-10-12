import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
import { inspectHelperInventory } from '../../../scripts/check-duplicate-helpers.mjs';

const head = 'ffb6660b517f554aa8702eb23b16c2b0389399e8';
const inherited = '991ca2f88e0e2829e2ec31a33cdc2e195a870cf3';
const git = (...args) => execFileSync('git', args).toString();
const config = JSON.parse(fs.readFileSync('scripts/registry-ownership.json', 'utf8'));
const previous = JSON.parse(git('show', inherited + ':scripts/registry-ownership.json'));
const strategy = config.profiles.find((p) => p.id === 'strategy-context-template-metadata');
assert(strategy); assert.equal(strategy.symbols.length, 8); assert.equal(strategy.carriers.length, 12);
assert.equal(strategy.edges.length, 10); assert.equal(strategy.aliases.length, 2);
assert.deepEqual(config.profiles.find((p) => p.id === 'tango-rest-page-leaves'), previous.profiles.find((p) => p.id === 'tango-rest-page-leaves'));
const files = new Map(git('ls-tree', '-r', '--name-only', head, '--', 'apps/api-strategy/src').trim().split('\n')
  .filter((p) => /\.(?:ts|tsx|mts|cts)$/.test(p) && !/(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)/.test(p))
  .map((p) => [p, fs.readFileSync(p, 'utf8')]));
const narrowed = { version: 1, profiles: [strategy] };
const baseline = inspectRegistryOwnership(files, narrowed);
assert.deepEqual(baseline.errors, []);
const owner = strategy.owner, front = 'apps/api-strategy/src/context/frontmatter.ts', report = 'apps/api-strategy/src/reports/report-context.ts';
const cases = [];
function inspect(name, mutate, expectedErrors = true) {
  const mutated = new Map(files); mutate(mutated);
  const result = inspectRegistryOwnership(mutated, narrowed);
  assert.equal(result.errors.length > 0, expectedErrors, name + ': ' + JSON.stringify(result.errors));
  cases.push({ name, refused: result.errors.length > 0, errors: result.errors });
}
function replace(map, file, before, after) {
  assert(map.get(file).includes(before), 'Missing mutation operand ' + before);
  map.set(file, map.get(file).replace(before, after));
}
const added = 'apps/api-strategy/src/context/source-map-independent-probe.ts';
inspect('duplicate complete metadata owner', (m) => m.set(added, m.get(owner)));
inspect('detached literal tuple alias', (m) => replace(m, front, 'export const DOCUMENT_TYPES = REGISTRY_DOCUMENT_TYPES;', "export const DOCUMENT_TYPES = ['strategy_brief'] as const;"));
inspect('let facade alias', (m) => replace(m, front, 'export const DOCUMENT_TYPES =', 'export let DOCUMENT_TYPES ='));
inspect('getter reexport facade', (m) => replace(m, front, 'export const DOCUMENT_TYPES = REGISTRY_DOCUMENT_TYPES;', "export { DOCUMENT_TYPES } from './template-registry.js';"));
inspect('widen seventeen tuple value', (m) => replace(m, owner, "  'route_and_vehicle_status',\n] as const;", "  'route_and_vehicle_status',\n  'unreviewed_type',\n] as const;"));
inspect('widen canonical document type', (m) => replace(m, owner, 'export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];', 'export type DocumentTypeValue = string;'));
inspect('widen facade document type', (m) => replace(m, front, 'export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];', 'export type DocumentTypeValue = string;'));
inspect('prefix identity drift', (m) => replace(m, owner, "{ prefix: '01_', section: 'situation' }", "{ prefix: '01-', section: 'situation' }"));
inspect('report output order drift', (m) => replace(m, owner, "  'decisions',\n  'intelligence',\n  'evidence',", "  'evidence',\n  'intelligence',\n  'decisions',"));
inspect('operational membership drift', (m) => replace(m, owner, "export const OPERATIONAL_REPORT_TEMPLATE_KEYS = new Set([\n  '00_context_manifest',", "export const OPERATIONAL_REPORT_TEMPLATE_KEYS = new Set([\n  '00_other',"));
inspect('title drift', (m) => replace(m, owner, "situation: 'Situation and stakes'", "situation: 'Unreviewed title'"));
inspect('local report prefix bypass', (m) => replace(m, report, 'return reportFallbackSection(templateKey);', 'return "governance";'));
inspect('local report membership bypass', (m) => replace(m, report, 'isOperationalReportTemplate(document.templateKey)', 'false'));
inspect('metadata helper membership bypass', (m) => replace(m, owner, 'return OPERATIONAL_REPORT_TEMPLATE_KEYS.has(templateKey);', 'return false;'));
inspect('shadowed compatibility binding', (m) => replace(m, front, 'export const DOCUMENT_TYPES = REGISTRY_DOCUMENT_TYPES;', 'export const DOCUMENT_TYPES = (() => { const REGISTRY_DOCUMENT_TYPES = []; return REGISTRY_DOCUMENT_TYPES; })();'));
inspect('same-name local fallback definition', (m) => m.set(report, m.get(report) + '\nfunction reportFallbackSection(value: string) { return "governance"; }\n'));
inspect('unlisted named consumer', (m) => m.set(added, "import { reportFallbackSection } from './template-registry.js';\nexport const value = reportFallbackSection('01_custom');\n"));
inspect('namespace owner import', (m) => m.set(added, "import * as owner from './template-registry.js';\nexport const value = owner.DOCUMENT_TYPES;\n"));
inspect('default owner import', (m) => m.set(added, "import owner from './template-registry.js';\nexport const value = owner;\n"));
inspect('side-effect owner import', (m) => m.set(added, "import './template-registry.js';\n"));
inspect('import-equals owner reference', (m) => m.set(added, "import owner = require('./template-registry.js');\nexport const value = owner;\n"));
inspect('static dynamic owner import', (m) => m.set(added, "export const value = import('./template-registry.js');\n"));
inspect('aliased require owner reference', (m) => m.set(added, "const get = require;\nexport const value = get('./template-registry.js');\n"));
inspect('owner missing', (m) => m.delete(owner));
inspect('benign comment contains owned names', (m) => m.set(owner, m.get(owner) + '\n// DOCUMENT_TYPES reportFallbackSection only comment text\n'), false);
inspect('benign unrelated local binding', (m) => m.set(added, 'const separateValue = "metadata"; export const unrelated = separateValue;\n'), false);
const after = inspectRegistryOwnership(files, narrowed); assert.deepEqual(after.errors, []);
const inventory = fs.readFileSync('scripts/duplicate-helper-names.txt', 'utf8');
const originalRows = git('show', inherited + ':scripts/duplicate-helper-names.txt');
const addedRows = inventory.slice(originalRows.length);
assert(inventory.startsWith(originalRows));
assert.equal(addedRows, 'strategy-context-template-metadata\tisOperationalReportTemplate\nstrategy-context-template-metadata\treportFallbackSection\n');
const helperCheck = inspectHelperInventory(config, inventory); assert.deepEqual(helperCheck.errors, []); assert.equal(helperCheck.helpers, 5);
const missing = inspectHelperInventory(config, inventory.replace('strategy-context-template-metadata\treportFallbackSection\n', ''));
assert(missing.errors.some((e) => e.includes('missing helper inventory row')));
const oldPackage = JSON.parse(git('show', inherited + ':package.json'));
const currentPackage = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const alias = 'gate:cleanup4:strategy-template-metadata';
const value = currentPackage.scripts[alias];
assert.equal(value, 'pnpm --filter @capiro/api-strategy exec jest --config ../../scripts/cleanup-runtime-equivalence.jest.cjs --runInBand --runTestsByPath src/context/template-registry.spec.ts src/context/frontmatter.spec.ts src/reports/report-context.spec.ts');
delete currentPackage.scripts[alias]; assert.deepEqual(currentPackage, oldPackage);
const oldCi = git('show', inherited + ':.github/workflows/ci-pr.yml');
const currentCi = fs.readFileSync('.github/workflows/ci-pr.yml', 'utf8');
const addition = '      - name: Test reviewed Strategy template metadata\n        run: pnpm gate:cleanup4:strategy-template-metadata\n\n';
assert(currentCi.includes(addition)); assert.equal(currentCi.replace(addition, ''), oldCi);
for (const file of ['context-import.service.ts', 'context-documents.service.ts', 'steward.service.ts']) {
  const p = 'apps/api-strategy/src/context/' + file;
  assert.equal(fs.readFileSync(p, 'utf8'), git('show', '802bbd0b2c510a44e46a9952d8127e7edc55aaaa:' + p));
}
console.log(JSON.stringify({ integratedSource: head, integratedTree: 'd5a9e8e887ae4f091d9dcbc6bb307ed7d828134c', inherited,
  applicationSourceFreeze: '8834c1d76659b343fb37c60733fa1dd618a06db9',
  strategySourceMapFiles: files.size, strategyOnlyActualSourceBaseline: baseline,
  actualSourceFaultCases: cases.length, refusedMutants: cases.filter((c) => c.refused).length, acceptedBenignCases: cases.filter((c) => !c.refused).length, cases,
  strategyDataCounts: { runtimeSymbols: 8, pinnedCarriersIncludingBothTypeAliases: 12, compatibilityAliases: 2, canonicalAndFacadeEdges: 10 },
  inheritedTangoProfileValuesExact: true, inheritedTangoProfileTextFormattingQualification: 'JSON roots array whitespace was reformatted; structured profile, values and ordering are exact.',
  inheritedHelperRowsExact: true, strategyHelperRows: 2, wholeHelperInventory: helperCheck,
  packageOnlyAddsFocusedAlias: true, ciOnlyAddsUnconditionalFocusedStep: true,
  threeOriginalServicesByteExact: true, baselineAfterFaultsStillPass: true,
  scope: 'Only Strategy actual-sourceMap/data faults. Generic root controls and inherited Tango application/profile acceptance belong to independent owners; Core/reporting sources were not read.',
  packageManagerCiProviderDatabaseNativeExecution: false,
}, null, 2));
