#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || 'origin/main';

/**
 * Phase 27A architecture guard for `learning_signal` (LearningSignal).
 *
 * Modeled on the two existing guard styles in this repo — the diff+census
 * pattern from `check-context-plane-new-bypasses.mjs`, and the
 * schema-derived model list from `apps/api/src/prisma/tenant-scope-guard.spec.ts`
 * — rather than inventing a third style. Extend this file (don't replace it)
 * as later Phase 27 sub-phases (candidate generation, governance
 * integration, ...) add their own tables/services.
 *
 * What this guards, concretely:
 *  1. `learning_signal` is written ONLY through LearningSignalCaptureService,
 *     never via a bare `tx.learningSignal.create/update/upsert` elsewhere.
 *  2. Nothing under `apps/api/src/learning/` references the existing governed
 *     memory system's write surface (memory_items / memory_candidate /
 *     clio_memory / MemoryCandidateService / MemoryStoreService) — the core
 *     27A invariant that capturing a signal can NEVER itself create active
 *     memory. Promotion is later-phase work and must go through the
 *     existing governance services from outside this directory, not from
 *     inside it.
 *  3. The LearningSignal Prisma model carries a `tenantId` field (so it is
 *     automatically covered by PrismaService's tenant-scope extension and
 *     tenant-scope-guard.spec.ts) and no vector/embedding column (no second
 *     vector database).
 *  4. `proposed_memory_layer`'s CHECK constraint in the migration lists
 *     exactly the five frozen SteeringLayer values — no sixth layer.
 */

const LEARNING_IMPLEMENTATION_PREFIXES = [
  'apps/api/src/learning/',
  'packages/meriv2-core/src/learning/',
];

const TEST_SUFFIXES = ['.spec.ts', '.test.ts'];

const BANNED_ADDITION_PATTERNS = [
  // Direct Prisma access to the table, bypassing LearningSignalCaptureService.
  /\btx\.learningSignal\./,
  /\bprisma\.learningSignal\./,
  /\.learningSignal\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
];

const FROZEN_STEERING_LAYERS = [
  'firm-identity',
  'firm-playbook',
  'user-voice',
  'client-steering',
  'client-people',
];

/**
 * Symbols from the EXISTING governed-memory write surface. If any of these
 * appear inside apps/api/src/learning/ (outside its own spec files), 27A has
 * started promoting signals into active memory — explicitly out of scope
 * (handoff §22, 27A acceptance criteria: "no signal becomes active memory").
 */
const BANNED_PROMOTION_SYMBOLS = [
  /\bmemory_items\b/,
  /\bmemory_candidate\b/,
  /\bclio_memory\b/,
  /\bMemoryCandidateService\b/,
  /\bMemoryStoreService\b/,
  /\bmemoryCandidate\s*:\s*prisma/, // defensive: a raw prisma.memoryCandidate access
];

/** Explicitly reviewed exceptions. Each stops being valid the moment the line changes. */
const APPROVED_ADAPTER_LINES = [];

function isApproved(file, line) {
  return APPROVED_ADAPTER_LINES.some((entry) => entry.file === file && entry.line === line.trim());
}

function isTestFile(file) {
  return TEST_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

function isLearningImplementationFile(file) {
  return LEARNING_IMPLEMENTATION_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

function listTrackedFiles(extPattern) {
  const out = [];
  const roots = ['apps', 'packages'];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const full = join(dir, entry).split('\\').join('/');
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (extPattern.test(full)) out.push(full);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

let failures = 0;
function fail(message) {
  console.error(`FAIL: ${message}`);
  failures += 1;
}
function ok(message) {
  console.log(`OK: ${message}`);
}

// ── 1+2. Diff guard: newly added lines outside the learning implementation
// directories must not bypass LearningSignalCaptureService or reach into the
// governed-memory write surface FROM WITHIN the learning directories.
let diff;
try {
  diff = git(['diff', '--unified=0', '--no-color', `${base}...HEAD`, '--', '*.ts', '*.tsx']);
} catch (error) {
  console.warn(`WARN: could not diff against ${base} (${error.message}); skipping diff-scoped checks.`);
  diff = '';
}

if (diff) {
  let currentFile = null;
  for (const rawLine of diff.split('\n')) {
    const fileMatch = rawLine.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    if (!currentFile || !rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;
    const added = rawLine.slice(1);
    if (isTestFile(currentFile)) continue;

    if (!isLearningImplementationFile(currentFile)) {
      for (const pattern of BANNED_ADDITION_PATTERNS) {
        if (pattern.test(added) && !isApproved(currentFile, added)) {
          fail(
            `${currentFile}: added line bypasses LearningSignalCaptureService — direct learningSignal table access outside apps/api/src/learning/.\n  ${added.trim()}`,
          );
        }
      }
    } else {
      for (const pattern of BANNED_PROMOTION_SYMBOLS) {
        if (pattern.test(added)) {
          fail(
            `${currentFile}: added line inside the learning implementation references the governed-memory write surface — 27A must never promote a signal into active memory.\n  ${added.trim()}`,
          );
        }
      }
    }
  }
}
if (failures === 0) ok('diff-scoped bypass/promotion check passed');

// ── 3. Repo-wide census: every `.learningSignal` reference outside the
// implementation directories, regardless of when it landed (diff-blind spot).
const allTsFiles = listTrackedFiles(/\.(ts|tsx)$/);
const censusFailures = [];
for (const file of allTsFiles) {
  if (isLearningImplementationFile(file) || isTestFile(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const pattern of BANNED_ADDITION_PATTERNS) {
    if (pattern.test(content)) censusFailures.push(file);
  }
}
if (censusFailures.length) {
  for (const file of new Set(censusFailures)) {
    fail(`${file}: references learningSignal directly, outside apps/api/src/learning/ (repo-wide census).`);
  }
} else {
  ok('repo-wide learningSignal census: zero out-of-module consumers');
}

// ── 4. Schema shape: tenantId present, no vector/embedding column.
const schemaPath = 'apps/api/prisma/schema.prisma';
let schema = '';
try {
  schema = readFileSync(schemaPath, 'utf8');
} catch (error) {
  fail(`could not read ${schemaPath}: ${error.message}`);
}
const modelMatch = schema.match(/model LearningSignal \{([\s\S]*?)\n\}/);
if (!modelMatch) {
  fail(`${schemaPath}: model LearningSignal not found`);
} else {
  const body = modelMatch[1];
  if (!/tenantId\s+String/.test(body)) {
    fail('LearningSignal model has no tenantId field — would NOT be auto-covered by the tenant-scope guard.');
  } else {
    ok('LearningSignal.tenantId present — auto-covered by PrismaService tenant-scope + tenant-scope-guard.spec.ts');
  }
  if (/@db\.Vector|Unsupported\("vector"\)|pgvector/i.test(body)) {
    fail('LearningSignal model appears to declare a vector/embedding column — a second vector database is out of scope for Phase 27.');
  } else {
    ok('LearningSignal model has no vector/embedding column');
  }
}

// ── 5. Migration CHECK constraint: exactly the five frozen layers, no more.
const migrationGlob = listTrackedFiles(/migration\.sql$/).filter((f) =>
  f.includes('learning_signal_foundation'),
);
if (!migrationGlob.length) {
  fail('no learning_signal_foundation migration.sql found');
} else {
  const sql = readFileSync(migrationGlob[0], 'utf8');
  const checkMatch = sql.match(/proposed_memory_layer[\s\S]*?IN \(([\s\S]*?)\)/);
  if (!checkMatch) {
    fail(`${migrationGlob[0]}: could not find proposed_memory_layer CHECK constraint`);
  } else {
    const listed = [...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const expected = [...FROZEN_STEERING_LAYERS].sort();
    const actual = [...listed].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      fail(
        `${migrationGlob[0]}: proposed_memory_layer CHECK lists [${actual.join(', ')}], expected exactly the five frozen layers [${expected.join(', ')}] — no sixth layer.`,
      );
    } else {
      ok('proposed_memory_layer CHECK constraint lists exactly the five frozen SteeringLayer values');
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} learning-signal architecture guard failure(s).`);
  process.exit(1);
} else {
  console.log('\nlearning-signal architecture guard passed.');
}
