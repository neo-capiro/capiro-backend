import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ts = createRequire('/workspace/capirov2/apps/api/package.json')('typescript');
const source = process.argv[2];
assert.match(source, /^[a-f0-9]{40}$/);
const parent = 'cb5d83e6b2d64dba0e882685e102883b9da0fea0';
const rel = 'scripts/cleanup-script-smoke/pe-core-verifier-cli-contracts.test.mjs';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const blob = (ref, file) => git('show', `${ref}:${file}`);
const digest = str => createHash('sha256').update(str).digest('hex');
const parse = text => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const original = parse(blob(parent, rel)), current = parse(blob(source, rel));
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = (node, sf) => printer.printNode(ts.EmitHint.Unspecified, node, sf);
const declaration = (sf, name) => sf.statements.filter(ts.isVariableStatement)
  .flatMap(node => Array.from(node.declarationList.declarations)).find(node => node.name.getText(sf) === name);
const invoke = sf => sf.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'invoke');
assert.equal(print(invoke(current), current), print(invoke(original), original));
assert.equal(declaration(current, 'probe').initializer.text, declaration(original, 'probe').initializer.text);
const caseFiles = sf => declaration(sf, 'cases').initializer.elements.map(el => el.properties.find(p => p.name.text === 'file').initializer.text);
assert.deepEqual(caseFiles(current), caseFiles(original));
const forLoop = sf => sf.statements.find(ts.isForOfStatement);
const loopTest = sf => forLoop(sf).statement.statements[0].expression;
assert.equal(loopTest(current).arguments[0].getText(current), loopTest(original).arguments[0].getText(original));
const callback = sf => loopTest(sf).arguments[1].body;
assert.deepEqual(Array.from(callback(current).statements).slice(-6).map(node => print(node, current)),
  Array.from(callback(original).statements).slice(-6).map(node => print(node, original)));
const lastTest = sf => sf.statements.filter(ts.isExpressionStatement).at(-1);
assert.equal(print(lastTest(current), current), print(lastTest(original), original));
const wrappers = ['lint-pe-scripts.ts', 'verify-pe-migration-guards.ts', 'verify-pe-phase-e-exact-sha.ts'].map(name => `apps/api/scripts/${name}`);
const wrapperHashes = wrappers.map(file => {
  assert.equal(blob(source, file), blob(parent, file));
  return { path: file, sourceSha256: digest(blob(source, file)) };
});
assert.deepEqual(git('diff', '--name-only', parent, source, '--', 'apps', 'packages', 'scripts', '.github').trim().split('\n'), [rel]);
const refusalBranch = callback(current).statements.find(node => ts.isIfStatement(node) && node.expression.getText(current) === 'subject.failure').elseStatement;
const subject = { usage: 'inert usage\n', refusedFacade: 'parse-defense-approps-public-law.ts' };
const expectedFailures = [
  'parse-defense-approps-public-law.ts: does not import pe-exact-sha-loader-contract',
  'parse-defense-approps-public-law.ts: missing resolvePeDollarLoaderPosture',
  'parse-defense-approps-public-law.ts: missing assertExactShaCommitAllowed',
  'parse-defense-approps-public-law.ts: missing approved-sha256 wiring',
];
const configuredFailures = declaration(current, 'cases').initializer.elements[2].properties
  .find(prop => prop.name.text === 'failuresExpected');
if (configuredFailures) {
  subject.failuresExpected = Array.from(configuredFailures.initializer.elements).map(el => el.text);
  assert.deepEqual(subject.failuresExpected, expectedFailures, 'source expected violations differ from original strict refusal');
}
function probeFailures(failures) {
  const normal = { stderr: subject.usage + JSON.stringify({ ok: false, failures }) };
  let accepted = true, failure = null;
  try { runInNewContext(print(refusalBranch, current), { subject, normal, assert, JSON }, { timeout: 1000 }); }
  catch (error) { accepted = false; failure = error.message; }
  return { failures, accepted, failure };
}
const correct = probeFailures(expectedFailures);
const duplicate = probeFailures(Array(4).fill(expectedFailures[0]));
const invented = probeFailures(Array(4).fill('parse-defense-approps-public-law.ts: arbitrary unrelated failure'));
assert.equal(correct.accepted, true);
console.log(JSON.stringify({ source, tree: git('rev-parse', `${source}^{tree}`).trim(), comparedTo: parent,
  testSourceSha256: digest(blob(source, rel)), allFourTestCaseNamesPreserved: true,
  childInvocationResourcePreloadHelpUnknownAndOptionalPrismaControlsUnchanged: true,
  wrapperSourceByteIdentical: wrapperHashes, sourceOnly: true, actualSubjectOrNativeSubprocessInvoked: false,
  probes: [correct, duplicate, invented] }, null, 2));
assert.equal(duplicate.accepted, false, 'four duplicate messages accepted by exact-SHA default refusal sentinel');
assert.equal(invented.accepted, false, 'four arbitrary messages accepted by exact-SHA default refusal sentinel');
