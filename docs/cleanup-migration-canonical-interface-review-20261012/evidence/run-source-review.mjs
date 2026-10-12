import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { sourceAdversaries } from './source-adversaries.mjs';

const require = createRequire(import.meta.url);
const compiler = require('typescript');
const here = new URL('./', import.meta.url);
const helperPath = 'apps/api/scripts/lib/pe-migration-guards.ts';
const helper = readFileSync(helperPath, 'utf8');
const exports = {};
const javascript = compiler.transpileModule(helper, {
  compilerOptions: { module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022 },
}).outputText;
// Execute only the pure guard with inert source arguments. Shell mutants never
// run; dependency access is limited to the hash primitive, not a module graph.
vm.runInNewContext(javascript, {
  exports,
  require: (name) => {
    assert.equal(name, 'node:crypto', 'unexpected dependency in pure source guard');
    return { createHash };
  },
});
const source = process.argv[3];
const phase = process.argv[2];
const paths = ['scripts/entrypoint.sh', 'scripts/entrypoint-legacy.sh', 'scripts/entrypoint-dispatcher.inc'];
const original = paths.map((path) => ({ path, source: readFileSync('apps/api/' + path, 'utf8') }));
const results = sourceAdversaries(original).map(({ name, snapshots, expected }) => {
  const result = exports.assertNoMigrationHistoryMutation(snapshots);
  return {
    name, expected, actual: result.ok, matches: result.ok === expected,
    findings: JSON.parse(JSON.stringify(result.findings)),
    sourceHashes: snapshots.map((snap) => ({ path: snap.path, sha256: createHash('sha256').update(snap.source).digest('hex') })),
  };
});
const generic = [
  ['safe unknown deployment', 'node ./node_modules/prisma/build/index.js migrate deploy\n', true],
  ['educational unknown comments', '# prisma migrate resolve\n# _prisma_migrations\nnode prisma migrate deploy\n', true],
  ['unknown manual looking source', 'case "${1:-serve}" in\n migrate-resolve-applied)\n exec node prisma migrate resolve --applied "$1"\n ;;\nesac\n', false],
  ['history edit unknown source', 'UPDATE _prisma_migrations SET rolled_back_at = NOW()\n', false],
  ['resolve unknown source', 'node ./node_modules/prisma/build/index.js migrate resolve --rolled-back hidden\n', false],
].map(([name, body, expected]) => {
  const result = exports.assertNoMigrationHistoryMutation([{ path: 'unreviewed.sh', source: body }]);
  return { name, expected, actual: result.ok, matches: result.ok === expected, findings: JSON.parse(JSON.stringify(result.findings)) };
});
const replay = [
  { cleanReplayExitCode: 0, upgradeReplayExitCode: 0, expected: true },
  { cleanReplayExitCode: 0, usedMigrateResolve: true, expected: false },
  { cleanReplayExitCode: 0, mutatedPrismaMigrationsTable: true, expected: false },
  { cleanReplayExitCode: 1, expected: false },
  { cleanReplayExitCode: 0, upgradeReplayExitCode: 1, expected: false },
].map(({ expected, ...input }) => {
  const result = exports.interpretMigrateReplay(input);
  return { input, expected, actual: result.ok, matches: result.ok === expected, findings: JSON.parse(JSON.stringify(result.findings)) };
});
const receipt = {
  source, phase, helperSha256: createHash('sha256').update(helper).digest('hex'),
  compilerVersion: compiler.version, sourceCases: results.length,
  sourceMatched: results.filter((result) => result.matches).length,
  sourceMismatches: results.filter((result) => !result.matches).map((result) => result.name),
  generic, replay, results,
  shellMutantsExecuted: false, nativeOperations: false, runtimeAuthenticationClaim: false,
};
writeFileSync(new URL(`source-review-${phase}.json`, here), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ ...receipt, results: undefined }, null, 2));
assert(generic.every((result) => result.matches));
assert(replay.every((result) => result.matches));
if (phase !== 'baseline-red') assert.equal(receipt.sourceMismatches.length, 0);
