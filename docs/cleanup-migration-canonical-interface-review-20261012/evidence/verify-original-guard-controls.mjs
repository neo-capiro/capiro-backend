import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const compiler = createRequire(import.meta.url)('typescript');
const base = 'd70bb9724cf06dfee4863037d295942a9624b7ac';
const helperPath = 'apps/api/scripts/lib/pe-migration-guards.ts';
const readBase = (file) => execFileSync('git', ['show', base + ':' + file], { encoding: 'utf8' });
function declarations(file, text) {
  const sf = compiler.createSourceFile(file, text, compiler.ScriptTarget.Latest, true);
  const found = new Map();
  function visit(node) {
    if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name))
      found.set(node.name.text, node.getText(sf));
    if (compiler.isFunctionDeclaration(node) && node.name)
      found.set(node.name.text, node.getText(sf));
    if (compiler.isCallExpression(node) && compiler.isIdentifier(node.expression) && node.expression.text === 'test' && compiler.isStringLiteralLike(node.arguments[0]))
      found.set('test:' + node.arguments[0].text, node.arguments[1].getText(sf));
    compiler.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}
const original = declarations(helperPath, readBase(helperPath));
const current = declarations(helperPath, readFileSync(helperPath, 'utf8'));
const helperNames = ['FORBIDDEN_MIGRATION_HISTORY_PATTERNS', 'stripShellComments', 'countMigrateDeployInvocations', 'interpretPrismaValidateGenerate', 'interpretMigrateReplay'];
for (const name of helperNames) assert.equal(current.get(name), original.get(name), name + ' exact source unchanged');
const caseChecks = [];
for (const file of ['apps/api/scripts/lib/pe-migration-guards.spec.ts', 'apps/api/scripts/lib/pe-phase-a-safety.spec.ts']) {
  const old = declarations(file, readBase(file));
  const next = declarations(file, readFileSync(file, 'utf8'));
  for (const [name, body] of old) {
    if (!name.startsWith('test:')) continue;
    assert(next.has(name), 'original case name retained: ' + name);
    const expectedReconciliation = file.endsWith('pe-phase-a-safety.spec.ts') && name === 'test:supported entrypoints contain no automatic migration-history mutation';
    if (!expectedReconciliation) assert.equal(next.get(name), body, file + ':' + name + ' body unchanged');
    caseChecks.push({ file, name, exactBodyUnchanged: !expectedReconciliation, intentionalCanonicalAlignment: expectedReconciliation });
  }
}
const receipt = {
  base, source: 'a96af2e1161def587d4ed9b6b79be7e5ff042c5b',
  unchangedHelperDeclarations: helperNames.map((name) => ({ name, sha256: createHash('sha256').update(current.get(name)).digest('hex') })),
  originalCaseChecks: caseChecks, originalCaseNamesRetained: caseChecks.length,
  originalStrictNegativeAndReplayBodiesUnchanged: true,
  shellMutantsExecuted: false, nativeOperations: false,
};
writeFileSync(new URL('original-guard-controls-preserved.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ unchangedHelperDeclarations: helperNames.length, originalCaseNamesRetained: caseChecks.length, onlyIntentionalChangedCase: caseChecks.filter((item) => item.intentionalCanonicalAlignment), nativeOperations: false }, null, 2));
