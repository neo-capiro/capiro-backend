import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
import { inspectHelperInventory } from '../../../scripts/check-duplicate-helpers.mjs';

const require = createRequire(import.meta.url), ts = require('typescript');
const source = '7ea444c74a5637577aa0eb3cb99cb420b5f8223e';
const out = 'docs/cleanup-meri-local-dispatch-independent-review-20261012/evidence/';
const config = JSON.parse(fs.readFileSync('scripts/registry-ownership.json', 'utf8'));
const profile = config.profiles.find(p => p.id === 'meri-local-core-dispatch');
const files = new Map();
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(file) && !/(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)/.test(file)) files.set(file, fs.readFileSync(file, 'utf8'));
  }
}
walk('apps/api/src');
const scoped = { ...config, profiles: [profile] }, baseline = inspectRegistryOwnership(files, scoped);
assert.equal(baseline.errors.length, 0);
const helper = profile.owner, service = profile.edges[0].file;
const tests = [];
function replace(label, file, from, to) {
  assert(files.get(file).includes(from), label);
  const map = new Map(files); map.set(file, files.get(file).replace(from, to)); tests.push({ label, map, changed: file });
}
function add(label, path, content) { const map = new Map(files); assert(!map.has(path)); map.set(path, content); tests.push({ label, map, changed: path }); }
replace('widen canonical finite name to string', helper, "Extract<MeriCapability, { backend: 'meri' }>['name']", 'string');
replace('widen readonly callback registry', helper, 'Readonly<Record<MeriLocalToolName, () => unknown>>', 'Record<string, (...args: unknown[]) => unknown>');
replace('unknown helper returns instead of original failure', helper, 'return unknownTool(name as never);', 'return undefined as ReturnType<Registry[MeriLocalToolName]>;');
replace('accept inherited prototype tool keys', helper, '!Object.prototype.hasOwnProperty.call(registry, name)', '!(name in registry)');
add('duplicate owned helper declaration', 'apps/api/src/meri/reviewer-duplicate.ts', 'export function executeMeriLocalDispatch() { return undefined; }\n');
add('duplicate owned type declaration', 'apps/api/src/meri/reviewer-duplicate-type.ts', 'export type MeriLocalToolName = string;\n');
replace('wrong canonical import module', service, "from './meri-local-dispatch.js';", "from './reviewer-wrong-owner.js';");
add('unlisted new named runtime consumer', 'apps/api/src/meri/reviewer-new-consumer.ts', "import { executeMeriLocalDispatch } from './meri-local-dispatch.js';\nexport const next = executeMeriLocalDispatch;\n");
add('new namespace runtime consumer', 'apps/api/src/meri/reviewer-namespace-consumer.ts', "import * as next from './meri-local-dispatch.js';\nexport const tool = next.executeMeriLocalDispatch;\n");
replace('remove first active cancellation assertion', service, '    assertMeriToolRequestActive();\n    const researchPortfolio', '    const researchPortfolio');
replace('eager ResearchPortfolio owner resolution', service, '    const researchPortfolio =', '    const reviewerEagerOwner = this.requireResearchPortfolioTools();\n    const researchPortfolio =');
replace('ResearchPortfolio primitive name drift', service, "get_research_portfolio: () => researchPortfolio('get_research_portfolio')", "get_research_portfolio: () => researchPortfolio('manage_research_portfolio')");
replace('eager proposal getter before selection', service, '    const legiwatch =', '    const reviewerProposal = execution?.actionProposalId;\n    const legiwatch =');
replace('Funding current actor source bypass', service, 'this.opportunityTools.searchFundingOpportunities(toolActor(ctx), {', 'this.opportunityTools.searchFundingOpportunities({ tenantId: ctx.tenantId }, {');
replace('Funding input first getter drift', service, "clientId: String(input.clientId ?? ''),\n          source: input.source as string | undefined,", "clientId: String(input.source ?? ''),\n          source: input.source as string | undefined,");
replace('capture per actor context on owner instance', service, '    const registry = {\n      manage_research_portfolio:', '    (this as any).reviewerCachedActor = ctx;\n    const registry = {\n      manage_research_portfolio:');
replace('pass cached actor to current use authority', service, '          scopeService: this.researchPortfolioScope,\n          ctx,', '          scopeService: this.researchPortfolioScope,\n          ctx: (this as any).reviewerCachedActor,');
replace('unknown failure function returns instead of Error', service, '  throw new Error(`Unhandled Meri tool: ${value}`);', '  return undefined as never;');
const results = [];
for (const test of tests) {
  const text = test.map.get(test.changed);
  const sf = ts.createSourceFile(test.changed, text, ts.ScriptTarget.Latest, true);
  assert.equal(sf.parseDiagnostics.length, 0, `${test.label}: mutation must be parseable`);
  const result = inspectRegistryOwnership(test.map, scoped);
  assert(result.errors.length > 0, `${test.label}: incorrectly accepted`);
  results.push({ label: test.label, changed: test.changed, parsedWithoutDiagnostics: true, errors: result.errors });
  console.log(JSON.stringify({ label: test.label, rejected: true, errors: result.errors }));
}
const inventory = fs.readFileSync('scripts/duplicate-helper-names.txt', 'utf8');
const inventoryMissing = inspectHelperInventory(config, inventory.replace('meri-local-core-dispatch\texecuteMeriLocalDispatch\n', ''));
assert(inventoryMissing.errors.length);
const inventoryDuplicate = inspectHelperInventory(config, inventory + 'meri-local-core-dispatch\texecuteMeriLocalDispatch\n');
assert(inventoryDuplicate.errors.length);
const result = { source, baseline, refusals: results.length, results, inventoryMissing, inventoryDuplicate,
  mutationFilesWritten: false, mutationApplicationModulesImported: false, mutationsExecuted: false,
  scope: 'Meri actual profile carriers, declaration census and named import edges; bounded source grammar only', nativeAcceptance: false };
fs.writeFileSync(out + 'adoption-refusals.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source, baseline, refusals: results.length, inventoryRefusals: 2, mutationsExecuted: false }));
