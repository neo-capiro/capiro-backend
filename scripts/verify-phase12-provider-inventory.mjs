import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_LITERAL = ['amazon', 'titan-embed-text-v2:0'].join('.');
export const BASELINE_COMMIT = '42942dedad59382f4b4aac6f904b9aee0e02efa6';
const INVENTORY_SHA256 = 'fd0e818cdeddcce6d2730e0f6c3e9cfe985fd0f5dbd088f84b04de2026186a56';
const ADAPTER = 'apps/api/src/embeddings/titan-embedding.provider.ts';
const INVENTORY = 'docs/knowledge-plane/phase-12-titan-legacy-inventory.json';
const CATEGORIES = new Set(['runtime_owner', 'schema_comment', 'validation_fixture']);

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function sourcePath(path) {
  return (
    typeof path === 'string' &&
    /^(apps|packages|scripts)\//u.test(path) &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function identity(hit) {
  return JSON.stringify([hit.path, hit.lineText, hit.before, hit.after, hit.occurrences]);
}

export function validateInventory(value) {
  if (
    !exactKeys(value, ['schemaVersion', 'baselineCommit', 'entries']) ||
    value.schemaVersion !== 1 ||
    value.baselineCommit !== BASELINE_COMMIT ||
    !Array.isArray(value.entries) ||
    value.entries.length !== 14
  ) {
    throw new Error('Invalid pinned Phase 12 inventory');
  }
  const identities = new Set();
  for (const entry of value.entries) {
    if (
      !exactKeys(entry, [
        'path',
        'baselineLine',
        'lineText',
        'before',
        'after',
        'occurrences',
        'category',
        'ownerReference',
      ]) ||
      !sourcePath(entry.path) ||
      entry.path === ADAPTER ||
      !Number.isSafeInteger(entry.baselineLine) ||
      entry.baselineLine < 1 ||
      typeof entry.lineText !== 'string' ||
      !entry.lineText.includes(MODEL_LITERAL) ||
      !Array.isArray(entry.before) ||
      !Array.isArray(entry.after) ||
      entry.before.length > 2 ||
      entry.after.length > 2 ||
      [...entry.before, ...entry.after].some((line) => typeof line !== 'string') ||
      !Number.isSafeInteger(entry.occurrences) ||
      entry.occurrences < 1 ||
      entry.occurrences !== entry.lineText.split(MODEL_LITERAL).length - 1 ||
      !CATEGORIES.has(entry.category) ||
      typeof entry.ownerReference !== 'string' ||
      !entry.ownerReference.startsWith('docs/')
    ) {
      throw new Error('Malformed Phase 12 inventory entry');
    }
    const key = identity(entry);
    if (identities.has(key)) throw new Error('Duplicate Phase 12 inventory entry');
    identities.add(key);
  }
  // This checksum pins the independently reviewed inventory, rather than learning
  // exceptions from whichever branch happens to be running CI.
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if (digest !== INVENTORY_SHA256) throw new Error('Unreviewed Phase 12 inventory content');
  return value;
}

export function readInventory(root) {
  return validateInventory(JSON.parse(readFileSync(resolve(root, INVENTORY), 'utf8')));
}

export function occurrencesInSource(path, text) {
  if (!sourcePath(path) || path === ADAPTER) throw new Error('Unexpected scanned source path');
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  return lines.flatMap((lineText, index) => {
    const occurrences = lineText.split(MODEL_LITERAL).length - 1;
    return occurrences === 0
      ? []
      : [
          {
            path,
            line: index + 1,
            lineText,
            before: lines.slice(Math.max(0, index - 2), index),
            after: lines.slice(index + 1, index + 3),
            occurrences,
          },
        ];
  });
}

export function scanOccurrences(root) {
  const result = spawnSync(
    'git',
    [
      'grep',
      '--no-ext-grep',
      '-l',
      '-z',
      '-F',
      MODEL_LITERAL,
      '--',
      'apps/**',
      'packages/**',
      'scripts/**',
      ':!' + ADAPTER,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(
      'Phase 12 tracked source scan failed: ' +
        (result.error?.message ?? result.stderr ?? result.signal),
    );
  }
  if (result.status === 1) {
    if (result.stdout !== '') throw new Error('Inconsistent empty Phase 12 scan');
    return [];
  }
  if (!result.stdout.endsWith('\0')) throw new Error('Malformed Phase 12 git scan output');
  const paths = result.stdout.slice(0, -1).split('\0');
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate Phase 12 scanned path');
  return paths.flatMap((path) => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      readFileSync(resolve(root, path)),
    );
    return occurrencesInSource(path, text);
  });
}

export function compareOccurrences(inventory, actual) {
  validateInventory(inventory);
  const expected = new Map(inventory.entries.map((entry) => [identity(entry), 1]));
  const errors = [];
  for (const hit of actual) {
    const key = identity(hit);
    const remaining = expected.get(key) ?? 0;
    if (remaining === 0) {
      errors.push('Unqualified or additional Titan occurrence: ' + hit.path + ':' + hit.line);
    } else {
      expected.set(key, remaining - 1);
    }
  }
  for (const entry of inventory.entries) {
    if (expected.get(identity(entry)) > 0) {
      errors.push(
        'Missing, moved or changed qualified Titan owner: ' + entry.path + ':' + entry.baselineLine,
      );
    }
  }
  return errors;
}

export function main(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const inventory = readInventory(root);
  const actual = scanOccurrences(root);
  const errors = compareOccurrences(inventory, actual);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'Phase 12 exact Titan owner inventory: ' +
      actual.length +
      ' qualified occurrences; no new coupling.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
