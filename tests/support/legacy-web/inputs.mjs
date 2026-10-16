import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
export const LEGACY_SOURCE_COMMIT = '4e0c189c5d0522098be1c4916a033bb681d11c0b';
const manifest = JSON.parse(readFileSync(resolve(here, 'SOURCE-INPUTS.json'), 'utf8'));
if (manifest.sourceCommit !== LEGACY_SOURCE_COMMIT) throw new Error('Legacy source pin drift');

/** Read historical qualification data. Never imports or executes the retired UI. */
export function readLegacySourceInput(name) {
  const relative = `tests/support/legacy-web/source-inputs/${name}`;
  const entry = manifest.files.find(row => row.destination === relative && row.action === 'copy-as-historical-source-data');
  if (!entry) throw new Error(`Undeclared legacy source operand: ${name}`);
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current += sep + part;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Legacy source operand must be a regular non-symbolic path: ${relative}`);
    }
  }
  const bytes = readFileSync(current);
  assertLegacySourceBytes(entry, bytes);
  return bytes;
}

export function assertLegacySourceBytes(entry, bytes) {
  if (!entry || !Buffer.isBuffer(bytes)) throw new Error('Declared legacy source bytes required');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== entry.bytes || sha256 !== entry.sha256 || blob !== entry.gitBlob) {
    throw new Error(`Legacy source operand identity drift: ${entry.destination}`);
  }
}
