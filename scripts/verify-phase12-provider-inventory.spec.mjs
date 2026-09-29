import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MODEL_LITERAL,
  compareOccurrences,
  occurrencesInSource,
  readInventory,
  scanOccurrences,
  validateInventory,
} from './verify-phase12-provider-inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventory = readInventory(root);
const baseline = inventory.entries.map((entry) => ({
  ...structuredClone(entry),
  line: entry.baselineLine,
}));
const defects = (hits) => compareOccurrences(inventory, hits);

test('standalone validator, test and inventory changes trigger push and PR acceptance', () => {
  const workflow = readFileSync(join(root, '.github/workflows/knowledge-phase12-ci.yml'), 'utf8');
  for (const path of [
    'docs/knowledge-plane/phase-12-titan-legacy-inventory.json',
    'scripts/verify-phase12-provider-inventory.mjs',
    'scripts/verify-phase12-provider-inventory.spec.mjs',
  ]) {
    assert.equal(workflow.split("      - '" + path + "'").length - 1, 2);
  }
});

test('reviewed baseline and current tracked tree match the exact 14-site inventory', () => {
  assert.deepEqual(defects(baseline), []);
  assert.deepEqual(defects(scanOccurrences(root)), []);
});

test('new leak, including inside an existing qualified file, cannot inherit an exception', () => {
  for (const path of ['apps/api/src/meri/new-provider.ts', baseline[0].path]) {
    const extra = occurrencesInSource(path, 'const model = ' + JSON.stringify(MODEL_LITERAL) + ';');
    assert.ok(defects([...baseline, ...extra]).length > 0);
  }
});

test('additional identical occurrences and additional tokens on one line fail', () => {
  assert.ok(defects([...baseline, structuredClone(baseline[0])]).length > 0);
  const changed = structuredClone(baseline);
  changed[0].lineText += ' ' + MODEL_LITERAL;
  changed[0].occurrences += 1;
  assert.ok(defects(changed).length > 0);
});

test('changed context, moved owner, missing entry and comment-to-runtime changes fail', () => {
  for (const alter of [
    (hits) => {
      hits[0].before[0] += ' changed';
    },
    (hits) => {
      hits[0].path = 'apps/api/src/moved-schema.ts';
    },
    (hits) => {
      hits.pop();
    },
    (hits) => {
      hits[0].lineText = 'const model = ' + JSON.stringify(MODEL_LITERAL) + ';';
    },
  ]) {
    const changed = structuredClone(baseline);
    alter(changed);
    assert.ok(defects(changed).length > 0);
  }
  assert.ok(defects([]).length > 0);
});

test('line movement and CRLF checkout preserve exact owned source context', () => {
  const entry = inventory.entries[0];
  const block = [...entry.before, entry.lineText, ...entry.after].join('\r\n');
  const shifted = occurrencesInSource(entry.path, '\r\n\r\n' + block);
  const changed = structuredClone(baseline);
  changed[0] = shifted[0];
  assert.deepEqual(defects(changed), []);
});

test('malformed, duplicate, unpinned and silently changed inventory fails closed', () => {
  for (const alter of [
    (value) => {
      value.entries.pop();
    },
    (value) => {
      value.entries[1] = structuredClone(value.entries[0]);
    },
    (value) => {
      value.baselineCommit = '0'.repeat(40);
    },
    (value) => {
      value.entries[0].category = 'ignored';
    },
    (value) => {
      value.entries[0].path = '../outside.ts';
    },
    (value) => {
      value.entries[0].occurrences = 2;
    },
    (value) => {
      value.entries[0].before[0] += ' changed';
    },
    (value) => {
      value.entries[0].ownerReference += ':changed';
    },
    (value) => {
      value.ignored = true;
    },
  ]) {
    const changed = structuredClone(inventory);
    alter(changed);
    assert.throws(() => validateInventory(changed));
  }
  assert.throws(() => validateInventory(null));
});

function temporaryRepo(t) {
  const base = resolve(tmpdir());
  const dir = mkdtempSync(join(base, 'phase12-provider-guard-'));
  t.after(() => {
    const child = relative(base, resolve(dir));
    assert.ok(
      child &&
        child !== '..' &&
        !child.startsWith('..' + '/') &&
        !child.startsWith('..' + '\\') &&
        !isAbsolute(child),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(git(['init', '--quiet']).status, 0);
  return { dir, git };
}

test('real git scanner rejects leaked occurrences and keeps only the preexisting adapter exclusion', (t) => {
  const { dir, git } = temporaryRepo(t);
  const path = 'apps/api/src/meri/leak.ts';
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(
    join(dir, path),
    '// first\nconst model = ' + JSON.stringify(MODEL_LITERAL) + ';\n// last\n',
  );
  const adapter = 'apps/api/src/embeddings/titan-embedding.provider.ts';
  mkdirSync(dirname(join(dir, adapter)), { recursive: true });
  writeFileSync(join(dir, adapter), MODEL_LITERAL);
  assert.equal(git(['add', '--', 'apps']).status, 0);
  const hits = scanOccurrences(dir);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, path);
  assert.ok(defects(hits).some((error) => error.includes(path)));
});

test('git execution failure is not accepted as an empty scan', (t) => {
  const { dir } = temporaryRepo(t);
  assert.throws(() => scanOccurrences(join(dir, 'not-a-directory')), /scan failed/u);
});

test('unchanged sensitive API Bedrock guard still detects SDK coupling without a Titan literal', (t) => {
  const workflow = readFileSync(join(root, '.github/workflows/knowledge-phase12-ci.yml'), 'utf8');
  const block = workflow.match(
    /direct_bedrock_hits=\$\(git grep -n -E '([^']+)' --([\s\S]*?)\|\| true\)/u,
  );
  assert.ok(block, 'existing direct Bedrock guard is retained');
  const paths = [...block[2].matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  const { dir, git } = temporaryRepo(t);
  const path = 'apps/api/src/meri/leak.ts';
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(
    join(dir, path),
    "import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';\n",
  );
  assert.equal(git(['add', '--', path]).status, 0);
  const result = git(['grep', '-n', '-E', block[1], '--', ...paths]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(path));
  assert.match(workflow, /if \[ -n "\$direct_bedrock_hits" \]; then[\s\S]*?exit 1/u);
});
