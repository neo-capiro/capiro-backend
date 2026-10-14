// Finite committed Git-object integrity check, independent of sparse materialization.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const prefix = 'docs/backend-feature-flags-20261014/';
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
const text = (...args) => git(...args).toString().trim();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assert = (ok, why) => { if (!ok) throw new Error(why); };
const ref = process.argv[2] ?? 'HEAD';
const index = JSON.parse(git('show', `${ref}:${prefix}SHA256-INDEX.json`).toString());
const paths = text('ls-tree', '-r', '--name-only', ref, prefix).split('\n').filter(Boolean);
assert(JSON.stringify(paths.sort()) === JSON.stringify([...index.entries.map((row) => prefix + row.path), prefix + 'SHA256-INDEX.json'].sort()), 'Finite packet coverage mismatch');
let rawOutputs = 0;
for (const row of index.entries) {
  const bytes = git('show', `${ref}:${prefix}${row.path}`);
  assert(bytes.length === row.bytes && sha256(bytes) === row.sha256, `Packet mismatch ${row.path}`);
  if (row.path.endsWith('-output.raw.json')) {
    const raw = JSON.parse(bytes.toString()); const decoded = Buffer.from(raw.data, 'base64');
    assert(decoded.length === raw.bytes && sha256(decoded) === raw.sha256, `Raw output mismatch ${row.path}`);
    rawOutputs++;
  }
}
const source = JSON.parse(git('show', `${ref}:${prefix}SOURCE-RECEIPT.json`).toString());
assert(text('rev-parse', `${source.head}^{tree}`) === source.tree, 'Source tree mismatch');
git('merge-base', '--is-ancestor', source.head, ref);
assert(text('diff', '--name-only', source.head, ref, '--', 'apps', 'packages', 'scripts', 'infra') === '', 'Product changed above tested source');
for (const row of source.paths) {
  const bytes = git('show', `${ref}:${row.path}`);
  assert(text('rev-parse', `${ref}:${row.path}`) === row.blob && bytes.length === row.bytes && sha256(bytes) === row.sha256, `Product blob mismatch ${row.path}`);
}
for (const label of ['flags-committed-source', 'flags-narrow-emit-committed']) {
  const receipt = JSON.parse(git('show', `${ref}:${prefix}evidence/${label}-receipt.json`).toString());
  assert(receipt.head === source.head && receipt.tree === source.tree && receipt.exitCode === 0 && receipt.exactCommittedSource === true, `Unqualified receipt ${label}`);
}
console.log(JSON.stringify({ result: 'pass', ref: text('rev-parse', ref), tree: text('rev-parse', `${ref}^{tree}`),
  indexedPayloads: index.entries.length, derivedExclusions: ['SHA256-INDEX.json'], rawOutputs,
  productionPaths: source.paths.filter((row) => row.kind === 'production').length,
  testedSourceHead: source.head, scope: 'finite Git/source/receipt integrity; no runtime/native/deployment acceptance',
}, null, 2));
