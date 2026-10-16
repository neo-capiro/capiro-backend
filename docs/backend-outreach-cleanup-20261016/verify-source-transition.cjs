// Finite source-transition proof, separate from behavioral/native qualification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const base = 'a2e3eee209dc82d7536f3fc318a9d952c80e628a';
const git = (...args) => execFileSync('git', args, { cwd: root, timeout: 30000,
  maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const json = file => JSON.parse(read(file));
const show = file => git('show', `${base}:${file}`);
const exactReplace = (text, before, after) => {
  assert.equal(text.split(before).length, 2, 'one exact replacement operand');
  return text.replace(before, after);
};
const removal = json('docs/backend-outreach-cleanup-20261016/evidence/outreach-removal.json');
assert.equal(removal.sourceCommit, base);
const beforeBytes = show(removal.path);
assert.equal(sha(beforeBytes), removal.beforeSha256);
const before = beforeBytes.toString('utf8');
const lines = before.split(/(?<=\n)/);
const removed = new Set();
for (const region of removal.removedRegions) {
  const block = lines.slice(region.originalFirstLine - 1, region.originalLastLine).join('');
  assert.equal(sha(block), region.sha256, region.name);
  for (let line = region.originalFirstLine; line <= region.originalLastLine; line++) {
    assert(!removed.has(line), 'no overlapping removal'); removed.add(line);
  }
}
assert.equal(removed.size, 368);
let expected = lines.filter((_, index) => !removed.has(index + 1)).join('');
for (const edit of removal.removedImports) expected = exactReplace(expected, edit.before, edit.after);
expected = exactReplace(expected, removal.commentDelta.before, removal.commentDelta.after);
const current = read(removal.path);
assert.equal(current, expected, 'entire service equals exactly the declared deletion/import/comment transition');
assert.equal(sha(current), removal.afterSha256);
const doc = removal.preservedActiveSendJSDoc;
const activeDoc = lines.slice(doc.originalFirstLine - 1, doc.originalLastLine).join('');
assert.equal(sha(activeDoc), doc.sha256);
assert(current.includes(activeDoc), 'active send documentation retained');

const ledger = json('tests/support/legacy-outreach/CASE-OWNERSHIP.json');
assert.equal(ledger.sourceCommit, base);
assert.equal(ledger.sourceTree, git('rev-parse', `${base}^{tree}`).toString().trim());
const operands = [];
for (const operand of ledger.sourceInputs.requiredFiles) {
  const bytes = show(operand.path);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob, operand.gitBlobSha1, operand.path + ': canonical blob');
  assert.equal(sha(bytes), operand.sha256, operand.path + ': canonical bytes');
  assert.equal(bytes.length, operand.bytes);
  if (operand.path !== removal.path && !operand.path.endsWith('/engagement-intel-context.spec.ts')) {
    assert.equal(read(operand.path), bytes.toString('utf8'), operand.path + ': retained unchanged');
  }
  operands.push({ path: operand.path, blob, sha256: sha(bytes), bytes: bytes.length });
}
const oldSpecPath = 'apps/api/src/engagement/engagement-intel-context.spec.ts';
assert(!fs.existsSync(path.join(root, oldSpecPath)), 'old direct-private spec removed from current discovery');
// These pinned declarations use simple scalar literals. Refuse anything else.
function literal(value) {
  const quote = value[0]; assert(['\"', "'"].includes(quote));
  const inner = value.slice(1, -1);
  assert(!/\\(?![\\'"nrt])/.test(inner), 'finite scalar escape vocabulary');
  return inner.replace(/\\([\\'"nrt])/g, (_, escaped) => ({ n: '\n', r: '\r', t: '\t' }[escaped] ?? escaped));
}
let suite;
const oldCases = [];
for (const [index, line] of show(oldSpecPath).toString('utf8').split('\n').entries()) {
  const match = line.match(/^\s*(describe|test)\(\s*((?:'(?:\\.|[^'\\])*')|(?:"(?:\\.|[^"\\])*"))\s*,/);
  if (!match) continue;
  const title = literal(match[2]);
  if (match[1] === 'describe') suite = title;
  else oldCases.push({ id: suite + ' ' + title, suite, title, declarationLine: index + 1 });
}
const declared = ledger.historicalGroups.flatMap(group => group.cases);
assert.equal(oldCases.length, 7);
assert.deepEqual(declared.map(({ id, suite, title, declarationLine }) => ({ id, suite, title, declarationLine })), oldCases);
assert(declared.every(item => item.nativeStatus === 'UNRUN'));
const overlay = declared.find(item => item.title.startsWith('OUTREACH_CLIENT_PROFILE on:'));
assert.equal(overlay.currentOwnership.owner, null);
assert.match(overlay.currentOwnership.relationship, /NO CURRENT EQUIVALENT/);
assert.equal(ledger.manualHistoricalReplay.status, 'UNRUN');
const contractPath = 'scripts/ci/meri-domain-cleanup.contract.spec.mjs';
const prefix = text => { const index = text.indexOf('const RETIRED'); assert(index > 0); return text.slice(0, index); };
const oldPrefix = prefix(show(contractPath).toString('utf8'));
assert.equal(prefix(read(contractPath)), oldPrefix, 'all 22 Meri controls/imports/helpers remain byte-exact');
const changedApplications = git('diff', '--no-renames', '--name-only', base, 'HEAD', '--', 'apps', 'packages')
  .toString().trim().split('\n').filter(Boolean).sort();
assert.deepEqual(changedApplications, [oldSpecPath, removal.path].sort(), 'only two declared application paths differ');
const changedPaths = git('diff', '--no-renames', '--name-only', base, 'HEAD').toString().trim().split('\n').filter(Boolean);
const allowed = new Set([oldSpecPath, removal.path, contractPath,
  'scripts/ci/outreach-current-evidence.contract.spec.mjs', 'scripts/backend-source-qualification.mjs',
  'tests/support/legacy-outreach/CASE-OWNERSHIP.json']);
for (const file of changedPaths) assert(allowed.has(file) || file.startsWith('docs/backend-outreach-cleanup-20261016/'), file + ': allocated path');
assert.equal(git('rev-parse', 'HEAD:' + removal.path).toString().trim(), removal.afterBlob, 'committed service matches proven bytes');
const controls = ['scripts/ci/outreach-current-evidence.contract.spec.mjs', contractPath,
  'scripts/backend-source-qualification.mjs', 'scripts/backend-source-qualification.spec.mjs',
  'tests/support/legacy-outreach/CASE-OWNERSHIP.json'];
const tested = json('docs/backend-outreach-cleanup-20261016/evidence/outreach-focused-inputs.json');
assert.deepEqual(tested.inputs.map(input => input.path).sort(), [removal.path,
  contractPath, 'scripts/ci/outreach-current-evidence.contract.spec.mjs',
  'scripts/backend-source-qualification.mjs', 'scripts/backend-source-qualification.spec.mjs',
  'apps/api/src/engagement/generation/evidence-source.service.ts',
  'apps/api/src/engagement/generation/evidence-packet.types.ts',
  'apps/api/src/engagement/generation/evidence-freshness.ts',
  'apps/api/src/engagement/generation/alert-packet-client.service.ts'].sort(), 'nine distinct exact focused operands');
for (const input of tested.inputs) assert.equal(sha(read(input.path)), input.sha256, input.path + ': unchanged since focused stage');
const report = { sourceHead: git('rev-parse', 'HEAD').toString().trim(), sourceBase: base,
  serviceTransition: { before: removal.beforeSha256, after: sha(current), removedRegions: removal.removedRegions.length,
    removedPhysicalLines: removed.size, everyOtherServiceByte: 'unchanged except exact import and historical comment deltas',
    activeSendDocumentation: doc.sha256 }, changedApplications, changedPaths, canonicalOperands: operands,
  historicalCaseIdentities: oldCases, historicalNativeStatus: 'UNRUN', flagOnOverlayCurrentEquivalent: false,
  unchangedMeriContractPrefixSHA256: sha(oldPrefix),
  focusedStageInputs: tested,
  currentControlInputs: controls.map(file => ({ path: file, sha256: sha(read(file)) })),
  limits: 'Finite source ownership and exact byte transition only. Fixture contexts are not caller admission. No native/compiler/framework/build/image/DB/provider/historical execution.' };
fs.writeFileSync(path.join(__dirname, 'SOURCE-PROOF.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: 'PASS', sourceHead: report.sourceHead, applicationPaths: changedApplications.length,
  canonicalOperands: operands.length, historicalCases: oldCases.length, unchangedMeriPrefix: report.unchangedMeriContractPrefixSHA256 }));
