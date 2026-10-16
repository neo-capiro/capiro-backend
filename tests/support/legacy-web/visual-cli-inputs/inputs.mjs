import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceCommit = '4e0c189c5d0522098be1c4916a033bb681d11c0b';
const manifest = JSON.parse(readFileSync(path.join(directory, 'SOURCE-INPUTS.json'), 'utf8'));
const required = ['lighthouse-pe-watch.mjs.txt', 'package.json', 'vnext-visual-capture.mjs.txt'];
if (manifest.sourceCommit !== sourceCommit || manifest.schemaVersion !== 1 ||
    JSON.stringify(manifest.files.map(row => row.destination).sort()) !== JSON.stringify(required)) {
  throw new Error('Historical visual CLI input declaration drift');
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export function readVisualCliInput(name) {
  const entry = manifest.files.find(row => row.destination === name);
  if (!entry) throw new Error(`Undeclared historical visual CLI input: ${name}`);
  const target = path.join(directory, name);
  for (const component of [directory, target]) {
    const stat = lstatSync(component);
    if (stat.isSymbolicLink() || (component === target ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Historical visual CLI input must be a regular path: ${name}`);
    }
  }
  const bytes = readFileSync(target);
  if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256 || blob(bytes) !== entry.gitBlob) {
    throw new Error(`Historical visual CLI input identity drift: ${name}`);
  }
  return bytes;
}

/** Existing relocated Phase 1 harness: validate its declared exact path inverse. */
export function readRelocatedPhase1CliInput() {
  const parent = path.resolve(directory, '..');
  const seal = JSON.parse(readFileSync(path.join(parent, 'SOURCE-INPUTS.json'), 'utf8'));
  const source = 'apps/web/scripts/engagement-phase1-browser-parity.mjs';
  const entry = seal.files.find(row => row.source === source && row.action === 'move');
  if (seal.sourceCommit !== sourceCommit || !entry) throw new Error('Phase 1 harness source declaration drift');
  const target = path.join(parent, 'engagement-phase1-browser-parity.mjs');
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Phase 1 CLI input must be regular');
  const bytes = readFileSync(target);
  const original = Buffer.from(bytes.toString('utf8').replaceAll('tests/support/legacy-web/', 'apps/web/scripts/'));
  if (original.length !== entry.bytes || sha(original) !== entry.sha256 || blob(original) !== entry.gitBlob) {
    throw new Error('Phase 1 historical CLI input identity drift');
  }
  return bytes;
}
