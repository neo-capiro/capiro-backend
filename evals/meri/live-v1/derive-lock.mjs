import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.mjs';
import { frozenFixture } from './fixture.mjs';
import { normalizeText, sha256Bytes, sha256Stable, sha256Text } from './lib/stable.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const appendixPath = resolve(root, 'source/appendix-f.md');
const appendix = await readFile(appendixPath, 'utf8');
const artifactBytes = frozenFixture.sources['ARTIFACT-BRIEF-1'].facts.utf8Bytes;

if (process.argv[2]) {
  const original = normalizeText(await readFile(resolve(process.argv[2]), 'utf8'));
  const start = original.indexOf('### Appendix F. Original 75-case live benchmark');
  const end = original.indexOf('\n### Appendix G. Original Playwright/Promptfoo agent handoff', start);
  if (start < 0 || end < 0) throw new Error('Appendix F/G boundaries not found in comparison source');
  const expected = normalizeText(original.slice(start, end));
  const actual = normalizeText(appendix);
  if (actual !== expected) {
    let index = 0;
    while (index < actual.length && index < expected.length && actual[index] === expected[index]) index += 1;
    throw new Error(`Frozen Appendix F differs from source at character ${index}`);
  }
}

const lock = {
  schemaVersion: 1,
  normalization: 'unicode-nfc-lf-rtrim-no-final-newline; stable-json-sorted-keys-v1',
  contractSourceSha256: sha256Text(appendix),
  fixtureSha256: sha256Stable(frozenFixture),
  promptSha256: Object.fromEntries(cases.map((testCase) => [testCase.id, sha256Text(testCase.prompt)])),
};

console.log(JSON.stringify({ artifactByteSha256: sha256Bytes(Buffer.from(artifactBytes, 'utf8')), lock }, null, 2));
