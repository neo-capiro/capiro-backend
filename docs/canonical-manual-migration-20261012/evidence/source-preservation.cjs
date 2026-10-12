const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
const old = (name) => fs.readFileSync(path.join(__dirname, 'original-' + name), 'utf8');
const current = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const parse = (source) => ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function namedFunction(source, name) {
  const ast = parse(source);
  const fn = ast.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert(fn); return { source: fn.getText(ast), start: fn.getStart(ast), end: fn.end };
}
const oldGuard = old('pe-migration-guards.ts');
const nextGuard = current('apps/api/scripts/lib/pe-migration-guards.ts');
const unchangedFunctions = ['stripShellComments', 'countMigrateDeployInvocations', 'interpretPrismaValidateGenerate', 'interpretMigrateReplay'];
for (const name of unchangedFunctions) assert.equal(namedFunction(nextGuard, name).source, namedFunction(oldGuard, name).source);
function forbiddenPatterns(source) {
  const ast = parse(source);
  return ast.statements.find((s) => ts.isVariableStatement(s)
    && s.declarationList.declarations.some((d) => d.name.getText(ast) === 'FORBIDDEN_MIGRATION_HISTORY_PATTERNS')).getText(ast);
}
assert.equal(forbiddenPatterns(oldGuard), forbiddenPatterns(nextGuard));
const oldTests = old('pe-migration-guards.spec.ts');
const nextTests = current('apps/api/scripts/lib/pe-migration-guards.spec.ts');
const start = oldTests.indexOf("describe('pe-migration-guards (K4)'");
assert(start >= 0);
assert(nextTests.includes(oldTests.slice(start).trim()));
const beforePhase = old('verify-pe-phase-a-safety.ts');
const afterPhase = current('apps/api/scripts/verify-pe-phase-a-safety.ts');
const beforeFn = namedFunction(beforePhase, 'verifyMigrationGuard');
const afterFn = namedFunction(afterPhase, 'verifyMigrationGuard');
const restoredPhase = (afterPhase.slice(0, afterFn.start) + beforeFn.source + afterPhase.slice(afterFn.end))
  .replace("import { assertNoMigrationHistoryMutation } from './lib/pe-migration-guards.js';\n", '');
assert.equal(restoredPhase, beforePhase);
const beforeNames = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline-original-red-attempt2.json'), 'utf8'));
const afterNames = JSON.parse(fs.readFileSync(path.join(__dirname, 'source-protocol-current.json'), 'utf8'));
const fullNames = (d) => d.testResults.flatMap((s) => s.assertionResults.map((a) => a.fullName));
const baselineNames = fullNames(beforeNames);
const currentNames = fullNames(afterNames);
assert.equal(baselineNames.length, 10);
assert.equal(currentNames.length, 69);
for (const name of baselineNames) assert.equal(currentNames.filter((n) => n === name).length, baselineNames.filter((n) => n === name).length);
assert.equal(afterNames.numFailedTests, 0);
assert.equal(afterNames.numPendingTests, 0);
console.log(JSON.stringify({ sourceHead: 'a96af2e1161def587d4ed9b6b79be7e5ff042c5b',
  sourceTree: '88a1aea62dbaaf4a8aa82086caa7c9aea511d8d7',
  originalForbiddenPatternDeclarationByteExact: true,
  originalFourFunctionDeclarationsByteExact: unchangedFunctions,
  originalEntireFiveTestGuardDescribeBlockByteExact: true,
  phaseAOutsideMigrationFunctionAndOneImportByteExact: true,
  originalFullNamesRetained: 10, originalNamesRemoved: 0, currentCasesPassed: 69,
  guardSha256: sha(nextGuard), phaseASha256: sha(afterPhase), nativeAcceptance: false }, null, 2));
