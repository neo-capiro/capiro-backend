'use strict';
// Executes only the pure verifier helper against parsed source strings.
const fs = require('node:fs');
const vm = require('node:vm');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2-cleanup-source-prereqs/apps/api/node_modules/typescript');
const oldPin = 'fcbf671f585968144b30293c2b1a4fc146cd82ff';
const helperPath = 'apps/api/scripts/lib/pe-public-law-facade-containment.ts';
const facadePath = 'apps/api/scripts/parse-defense-approps-public-law.ts';
const oldSource = cp.execFileSync('git', ['show', `${oldPin}:${helperPath}`], { encoding: 'utf8' });
const currentSource = fs.readFileSync(helperPath, 'utf8');
const facade = fs.readFileSync(facadePath, 'utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function load(source) {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => {
    assert.equal(name, 'typescript');
    return ts;
  } }, { timeout: 1000 });
  return exports.publicLawFacadeContainmentFailures;
}
const oldCheck = load(oldSource);
const newCheck = load(currentSource);
assert.deepEqual(Array.from(oldCheck(facade)), []);
assert.deepEqual(Array.from(newCheck(facade)), []);
const cases = ['+', '-', '~', '++', '--'].map((operator) => ({
  name: 'array prefix ' + operator,
  source: facade.replace('if (!Array.isArray(candidatesRaw))', `if (${operator}Array.isArray(candidatesRaw))`),
}));
cases.push({ name: 'deferred filesystem import', source: facade.replace("import * as fs from 'node:fs'", "import defer * as fs from 'node:fs'") });
cases.push({ name: 'deferred schema import', source: facade.replace('import {\n  defenseBudget', 'import defer {\n  defenseBudget') });
const results = cases.map((item) => {
  assert.notEqual(item.source, facade);
  const oldFailures = Array.from(oldCheck(item.source));
  const repairedFailures = Array.from(newCheck(item.source));
  assert.deepEqual(oldFailures, [], 'original RED must reproduce: ' + item.name);
  assert.ok(repairedFailures.length > 0, 'repair must reject: ' + item.name);
  return { case: item.name, sourceSha256: sha(item.source), originalFailures: oldFailures, repairedFailures };
});
console.log(JSON.stringify({ originalSource: oldPin, compilerVersion: ts.version, originalHelperSha256: sha(oldSource), repairedHelperSha256: sha(currentSource), reproducedRedCases: 7, repairedRefusals: 7, results, nativeAcceptance: false }, null, 2));
