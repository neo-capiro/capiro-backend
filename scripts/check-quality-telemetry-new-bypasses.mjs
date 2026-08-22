#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || 'origin/main';

/**
 * Phase 27E architecture guard for `quality_telemetry_event` /
 * `quality_telemetry_memory_item_use`.
 *
 * Modeled directly on `check-learning-signal-new-bypasses.mjs` (same
 * diff+census two-pass style) — extend this file (don't replace it) as
 * later Phase 27E follow-ups add adapters.
 *
 * What this guards, concretely (Phase 27E handoff §30):
 *  1. `quality_telemetry_event` / `quality_telemetry_memory_item_use` are
 *     written ONLY through QualityTelemetryCaptureService, never via a bare
 *     `tx.qualityTelemetryEvent.create/update/...` elsewhere.
 *  2. Nothing under `apps/api/src/quality-telemetry/` may EVER write active
 *     memory (memory_items / clio_memory), resolve a candidate, or bypass
 *     governance — this is a FULL ban with NO exceptions, unlike
 *     `apps/api/src/learning/`'s one designated candidate-generation file:
 *     telemetry has no legitimate reason to ever touch the governed-write
 *     surface at all.
 *  3. Nothing under `apps/api/src/quality-telemetry/` may create a
 *     LearningSignal (bare `learningSignal.create`, or calling
 *     `LearningSignalCaptureService.capture`) — it may only ever READ an
 *     already-captured signal's id to store as a lifecycle-linkage pointer.
 *  4. Nothing under `apps/api/src/quality-telemetry/` may create a
 *     ContextPacket — it only ever references an existing packet's id.
 *  5. `QualityTelemetryEvent`/`QualityTelemetryMemoryItemUse` carry a
 *     `tenantId` field (auto-covered by tenant-scope-guard.spec.ts) and no
 *     vector/embedding column.
 *  6. The migration's `surface` / `event_type` / `context_layer` CHECK
 *     constraints match the frozen vocabularies in
 *     `packages/meriv2-core/src/quality-telemetry/contract.ts` exactly — in
 *     particular, `context_layer` lists exactly the five frozen
 *     SteeringLayer values, no sixth layer.
 *  7. `QualityTelemetryCaptureService.recordEvent` never throws into its
 *     caller: its body is a single top-level try/catch (a caller check, not
 *     a promise-shaped guess — every code path after the kill-switch check
 *     is wrapped).
 *  8. `QualityTelemetryModule` never imports `MemoryModule` or
 *     `LearningModule` — the DI graph itself proves this subsystem cannot
 *     reach the governed-write surface, independent of the source-level
 *     bans above.
 *  9. `InternalQualityTelemetryController` is guarded by
 *     `InternalServiceGuard` — the cross-service bridge Workspace/Strategies
 *     call is not an open route.
 *  10. No banned confidential-content field name (body/text/content/
 *      transcript/prompt/response/message/summary/note/excerpt/draft/
 *      subject) is ever assigned as a literal object key inside a
 *      `provenance`/`editMetrics`/`contextLayerCounts` value anywhere under
 *      `apps/api/src/quality-telemetry/` — defense-in-depth alongside the
 *      runtime `assertNoConfidentialContent` guard, catching a violation at
 *      review time rather than only at write time.
 */

const QT_IMPLEMENTATION_PREFIXES = [
  'apps/api/src/quality-telemetry/',
  'packages/meriv2-core/src/quality-telemetry/',
];

const TEST_SUFFIXES = ['.spec.ts', '.test.ts'];

const BANNED_ADDITION_PATTERNS = [
  /\btx\.qualityTelemetryEvent\./,
  /\bprisma\.qualityTelemetryEvent\./,
  /\.qualityTelemetryEvent\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
  /\btx\.qualityTelemetryMemoryItemUse\./,
  /\.qualityTelemetryMemoryItemUse\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
];

const FROZEN_STEERING_LAYERS = [
  'firm-identity',
  'firm-playbook',
  'user-voice',
  'client-steering',
  'client-people',
];

const EXPECTED_SURFACES = ['outreach', 'workspace', 'crm_fill', 'meetings', 'strategies', 'meri'];
const EXPECTED_EVENT_TYPES = [
  'generated', 'edited', 'regenerated', 'approved', 'rejected', 'held',
  'superseded', 'corrected', 'feedback_positive', 'feedback_negative',
  'ignored', 'unknown',
];

/**
 * FULL ban, no exceptions — telemetry has no legitimate reason to ever
 * reach the governed-write surface. Stricter than the learning-signal
 * guard's Check 2/3 (which carve out one designated file each), because
 * unlike candidate generation, quality telemetry is never supposed to
 * mutate memory or governance state at all.
 */
const BANNED_GOVERNED_WRITE_SYMBOLS = [
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+memory_items\b/i,
  /\bmemoryItem\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+clio_memory\b/i,
  /\bclioMemory\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
  /\bMemoryStoreService\b/,
  /\bImmutableMemoryVersionService\b/,
  /\bMemoryConflictService\b/,
  /\bMemoryCandidateService\b/,
  /\bmemoryCandidate\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+memory_candidate\b/i,
  /\bLearningSignalCandidateService\b/,
  /\bcontextPacket\.(create|update|upsert)\(/,
  /\b(INSERT\s+INTO|UPDATE)\s+context_packet\b/i,
];

/** May only ever READ an id, never create one. */
const BANNED_LEARNING_SIGNAL_CREATE_SYMBOLS = [
  /\blearningSignal\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+learning_signal\b/i,
  /\bLearningSignalCaptureService\b/,
];

const BANNED_CONTENT_KEYS = [
  'body', 'text', 'content', 'transcript', 'prompt', 'response', 'message',
  'summary', 'notes', 'note', 'excerpt', 'draft', 'subject',
];

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function isTestFile(file) {
  return TEST_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

function isQtImplementationFile(file) {
  return QT_IMPLEMENTATION_PREFIXES.some((prefix) => file.startsWith(prefix));
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

// ── 1. Diff guard: newly added lines outside the QT implementation
// directories must not bypass QualityTelemetryCaptureService; new lines
// INSIDE those directories must never reach the governed-write surface or
// create a LearningSignal/ContextPacket.
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

    if (!isQtImplementationFile(currentFile)) {
      for (const pattern of BANNED_ADDITION_PATTERNS) {
        if (pattern.test(added)) {
          fail(
            `${currentFile}: added line bypasses QualityTelemetryCaptureService — direct quality_telemetry table access outside apps/api/src/quality-telemetry/.\n  ${added.trim()}`,
          );
        }
      }
    } else if (!isCommentLine(added)) {
      for (const pattern of BANNED_GOVERNED_WRITE_SYMBOLS) {
        if (pattern.test(added)) {
          fail(
            `${currentFile}: added line inside quality-telemetry references the GOVERNED-WRITE surface — telemetry must never mutate active memory, resolve candidates, or create ContextPackets.\n  ${added.trim()}`,
          );
        }
      }
      for (const pattern of BANNED_LEARNING_SIGNAL_CREATE_SYMBOLS) {
        if (pattern.test(added)) {
          fail(
            `${currentFile}: added line inside quality-telemetry may CREATE a LearningSignal — telemetry may only read an existing signal's id.\n  ${added.trim()}`,
          );
        }
      }
    }
  }
}
if (failures === 0) ok('diff-scoped bypass/governed-write check passed');

// ── 2. Repo-wide census: every direct quality_telemetry table reference
// outside the implementation directories (diff-blind spot).
const allTsFiles = listTrackedFiles(/\.(ts|tsx)$/);
const censusFailures = [];
for (const file of allTsFiles) {
  if (isQtImplementationFile(file) || isTestFile(file)) continue;
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
    fail(`${file}: references quality_telemetry tables directly, outside apps/api/src/quality-telemetry/ (repo-wide census).`);
  }
} else {
  ok('repo-wide quality_telemetry table census: zero out-of-module consumers');
}

// ── 2b. Repo-wide census of CURRENT content of every QT implementation
// file — the governed-write ban and LearningSignal-create ban with zero
// exceptions (not diff-scoped, so it also catches pre-existing drift).
const qtImplFiles = [...listTrackedFiles(/\.ts$/), ...listTrackedFiles(/\.tsx$/)].filter(
  (f) => isQtImplementationFile(f) && !isTestFile(f),
);
let governedWriteCensusFailures = 0;
let signalCreateCensusFailures = 0;
let contentKeyCensusFailures = 0;
for (const file of qtImplFiles) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const codeLines = content.split('\n').filter((line) => !isCommentLine(line));
  const code = codeLines.join('\n');
  for (const pattern of BANNED_GOVERNED_WRITE_SYMBOLS) {
    if (pattern.test(code)) {
      fail(`${file}: references the governed-write surface (repo-wide census) — banned with no exceptions.`);
      governedWriteCensusFailures += 1;
    }
  }
  for (const pattern of BANNED_LEARNING_SIGNAL_CREATE_SYMBOLS) {
    if (pattern.test(code)) {
      fail(`${file}: may create a LearningSignal (repo-wide census) — banned with no exceptions.`);
      signalCreateCensusFailures += 1;
    }
  }
  // Check 10: banned content key literal, e.g. `body:` or `"note":` inside
  // an object literal. Heuristic but effective: a quoted/bare key followed
  // by a colon, matched against the banned list case-insensitively.
  for (const key of BANNED_CONTENT_KEYS) {
    const keyPattern = new RegExp(`[\\{,]\\s*['"]?${key}['"]?\\s*:`, 'i');
    if (keyPattern.test(code)) {
      fail(`${file}: assigns a banned content-shaped key "${key}:" — quality telemetry must never carry a body/text/content/transcript/prompt/response/message/summary/note/excerpt/draft/subject field.`);
      contentKeyCensusFailures += 1;
    }
  }
}
if (governedWriteCensusFailures === 0 && signalCreateCensusFailures === 0 && contentKeyCensusFailures === 0) {
  ok('repo-wide quality-telemetry-implementation census: no governed-write reference, no LearningSignal creation, no banned content-shaped key');
}

// ── 3. Schema shape: tenantId present, no vector/embedding column, on both models.
const schemaPath = 'apps/api/prisma/schema.prisma';
let schema = '';
try {
  schema = readFileSync(schemaPath, 'utf8');
} catch (error) {
  fail(`could not read ${schemaPath}: ${error.message}`);
}
for (const modelName of ['QualityTelemetryEvent', 'QualityTelemetryMemoryItemUse']) {
  const modelMatch = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  if (!modelMatch) {
    fail(`${schemaPath}: model ${modelName} not found`);
    continue;
  }
  const body = modelMatch[1];
  if (!/tenantId\s+String/.test(body)) {
    fail(`${modelName} model has no tenantId field — would NOT be auto-covered by the tenant-scope guard.`);
  } else {
    ok(`${modelName}.tenantId present — auto-covered by PrismaService tenant-scope + tenant-scope-guard.spec.ts`);
  }
  if (/@db\.Vector|Unsupported\("vector"\)|pgvector/i.test(body)) {
    fail(`${modelName} model appears to declare a vector/embedding column — a second vector database is out of scope for Phase 27E.`);
  } else {
    ok(`${modelName} model has no vector/embedding column`);
  }
}

// ── 4. Migration CHECK constraints match the frozen vocabularies exactly.
const migrationFiles = listTrackedFiles(/migration\.sql$/).filter((f) =>
  f.includes('phase27e_quality_telemetry'),
);
if (!migrationFiles.length) {
  fail('no phase27e_quality_telemetry migration.sql found');
} else {
  const sql = readFileSync(migrationFiles[0], 'utf8');
  checkVocabulary(sql, migrationFiles[0], 'context_layer', FROZEN_STEERING_LAYERS, 'the five frozen SteeringLayer values — no sixth layer');
  checkVocabulary(sql, migrationFiles[0], 'surface(?!_)', EXPECTED_SURFACES, 'the six frozen QualityTelemetrySurface values');
  checkVocabulary(sql, migrationFiles[0], 'event_type', EXPECTED_EVENT_TYPES, 'the frozen QualityTelemetryEventType vocabulary');
}

function checkVocabulary(sql, file, columnPattern, expectedList, label) {
  const re = new RegExp(`${columnPattern}[\\s\\S]*?IN \\(([\\s\\S]*?)\\)`);
  const match = sql.match(re);
  if (!match) {
    fail(`${file}: could not find a CHECK constraint for column matching /${columnPattern}/`);
    return;
  }
  const listed = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const expected = [...expectedList].sort();
  const actual = [...listed].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail(`${file}: CHECK for /${columnPattern}/ lists [${actual.join(', ')}], expected exactly [${expected.join(', ')}] — ${label}.`);
  } else {
    ok(`CHECK constraint for /${columnPattern}/ lists exactly ${label}`);
  }
}

// ── 5. recordEvent never throws: its entire body (after the disabled-flag
// early return) is one top-level try/catch.
const capturePath = 'apps/api/src/quality-telemetry/quality-telemetry-capture.service.ts';
let captureSource = '';
try {
  captureSource = readFileSync(capturePath, 'utf8');
} catch (error) {
  fail(`could not read ${capturePath}: ${error.message}`);
}
if (captureSource) {
  const methodMatch = captureSource.match(/async recordEvent\([\s\S]*?\{([\s\S]*?)\n  \}\n/);
  if (!methodMatch) {
    fail(`${capturePath}: could not locate recordEvent method body`);
  } else {
    const body = methodMatch[1];
    if (!/return\s*\{\s*status:\s*'disabled'\s*\}/.test(body)) {
      fail(`${capturePath}: recordEvent no longer returns the 'disabled' kill-switch result — check the flag guard is still first.`);
    }
    if (!/try\s*\{[\s\S]*validate\(input\)[\s\S]*\}\s*catch/.test(body)) {
      fail(`${capturePath}: recordEvent's validate(input)+write path is not wrapped in a single try/catch — a validation or DB error could throw into the caller, violating the never-block-the-workflow contract.`);
    } else {
      ok('recordEvent wraps validate()+write in one try/catch after the kill-switch check — never throws into its caller');
    }
  }
}

// ── 6. DI graph: QualityTelemetryModule never imports MemoryModule or LearningModule.
const modulePath = 'apps/api/src/quality-telemetry/quality-telemetry.module.ts';
let moduleSource = '';
try {
  moduleSource = readFileSync(modulePath, 'utf8');
} catch (error) {
  fail(`could not read ${modulePath}: ${error.message}`);
}
if (moduleSource) {
  const moduleCode = moduleSource.split('\n').filter((line) => !isCommentLine(line)).join('\n');
  if (/\bMemoryModule\b|\bLearningModule\b/.test(moduleCode)) {
    fail(`${modulePath}: imports MemoryModule or LearningModule — the DI graph itself must prove telemetry cannot reach the governed-write surface.`);
  } else {
    ok('QualityTelemetryModule imports neither MemoryModule nor LearningModule');
  }
}

// ── 7. The cross-service bridge is guarded.
const controllerPath = 'apps/api/src/quality-telemetry/internal-quality-telemetry.controller.ts';
let controllerSource = '';
try {
  controllerSource = readFileSync(controllerPath, 'utf8');
} catch (error) {
  fail(`could not read ${controllerPath}: ${error.message}`);
}
if (controllerSource && !/@UseGuards\(InternalServiceGuard\)/.test(controllerSource)) {
  fail(`${controllerPath}: not guarded by @UseGuards(InternalServiceGuard) — the Workspace/Strategies bridge would be an open route.`);
} else if (controllerSource) {
  ok('InternalQualityTelemetryController is guarded by InternalServiceGuard');
}

if (failures > 0) {
  console.error(`\n${failures} quality-telemetry architecture guard failure(s).`);
  process.exit(1);
} else {
  console.log('\nquality-telemetry architecture guard passed.');
}
