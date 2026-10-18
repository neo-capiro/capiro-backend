// Offline source/custody verification only. No installs, application boot or I/O ports.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packet = dirname(fileURLToPath(import.meta.url));
const root = resolve(packet, '../..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
const gitText = (...args) => git(...args).toString('utf8').trim();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blobId = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const pins = JSON.parse(readFileSync(resolve(packet, 'PIN-MATRIX.json'), 'utf8'));
let checkedPins = 0;
const unavailableOptionalPins = [];

for (const pin of pins.localPins) {
  // Optional branches are not ancestors of PR4; a fresh single-branch clone may lack them.
  let type;
  try { type = gitText('cat-file', '-t', pin.head); }
  catch (error) {
    assert(pin.id === 'optional-pr2' || pin.id === 'optional-pr3', `Missing required commit ${pin.id}`);
    unavailableOptionalPins.push(pin.id);
    continue;
  }
  assert(type === 'commit', `Wrong object type ${pin.id}`);
  assert(gitText('rev-parse', `${pin.head}^{tree}`) === pin.tree, `Tree mismatch ${pin.id}`);
  const parents = gitText('show', '-s', '--format=%P', pin.head).split(/\s+/).filter(Boolean);
  assert(JSON.stringify(parents) === JSON.stringify(pin.parents), `Parent mismatch ${pin.id}`);
  checkedPins++;
}

git('merge-base', '--is-ancestor', pins.reviewedSource, pins.planBase);
git('merge-base', '--is-ancestor', pins.planBase, 'HEAD');
git('merge-base', '--is-ancestor', 'c625fcc4b5fb7c4270e701fe090b9f408d9108fe', '6efe59f24b4a711b7991bae4b2a255c667cbbf00');
const delta = gitText('diff', '--name-only', pins.reviewedSource, 'HEAD').split('\n').filter(Boolean);
assert(delta.every((path) => path.startsWith('docs/')), 'This docs-only handoff contains product changes');
const auditDelta = gitText('diff', '--name-only', pins.reviewedSource, pins.planBase).split('\n').filter(Boolean);
assert(auditDelta.length === 4 && auditDelta.every((path) => path.startsWith('docs/api-four-family-acceptance-audit-20261014/')), 'Audit parent delta changed');

for (const row of pins.selectedSourceBlobs) {
  const spec = `${pins.reviewedSource}:${row.path}`;
  const bytes = git('show', spec);
  assert(gitText('rev-parse', spec) === row.blob, `Source blob mismatch ${row.path}`);
  assert(bytes.length === row.bytes && sha256(bytes) === row.sha256, `Source bytes mismatch ${row.path}`);
  assert(gitText('rev-parse', `HEAD:${row.path}`) === row.blob, `Source changed on docs branch ${row.path}`);
}

const reports = ['MERI-BOUNDARY.lossless.json', 'CLEANUP-AUDIT.lossless.json'];
for (const name of reports) {
  const row = JSON.parse(readFileSync(resolve(packet, name), 'utf8'));
  const bytes = Buffer.from(row.content, 'base64');
  assert(row.encoding === 'base64' && bytes.toString('base64') === row.content, `Noncanonical envelope ${name}`);
  assert(bytes.length === row.bytes && sha256(bytes) === row.sha256 && blobId(bytes) === row.blob, `Report mismatch ${name}`);
}
const auditRoot = resolve(root, 'docs/api-four-family-acceptance-audit-20261014');
const auditIndex = JSON.parse(readFileSync(resolve(auditRoot, 'SHA256-INDEX.json'), 'utf8'));
for (const row of auditIndex) {
  const bytes = readFileSync(resolve(auditRoot, row.path));
  assert(bytes.length === row.bytes && sha256(bytes) === row.sha256, `Audit packet mismatch ${row.path}`);
}

const activeWorkflows = gitText('ls-tree', '-r', '--name-only', 'HEAD', '.github/workflows');
assert(!activeWorkflows, 'Unexpected active workflow on docs handoff');
const archive = gitText('ls-tree', '-r', '--name-only', 'HEAD', 'docs/backend-repository-split-preparation-20261013/quarantine').split('\n').filter(Boolean);
assert(archive.length === 74, 'Quarantine archive count changed');
const agents = gitText('ls-tree', '-r', '--name-only', pins.reviewedSource).split('\n').filter((path) => /(^|\/)AGENTS\.md$/.test(path));
assert(agents.length === 0, 'Refresh AGENTS instructions: receiving tree now contains AGENTS');

console.log(JSON.stringify({
  schema: 'private-backend-successor-plan-verification/v1',
  result: 'pass', observedHead: gitText('rev-parse', 'HEAD'), observedTree: gitText('rev-parse', 'HEAD^{tree}'),
  checkedPins, unavailableOptionalPins, selectedSourceBlobs: pins.selectedSourceBlobs.length,
  exactLosslessReports: reports.length, auditDocs: auditDelta.length, auditIndexedFiles: auditIndex.length,
  disabledAutomationArchive: archive.length,
  scope: 'offline Git/source/custody checks; no application, tests, native DB/RLS, network, provider or deployment acceptance',
}, null, 2));
