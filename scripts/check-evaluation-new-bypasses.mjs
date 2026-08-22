#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || 'origin/main';

/**
 * Phase 27F architecture guard for `evaluation_record`.
 *
 * Modeled directly on `check-quality-telemetry-new-bypasses.mjs` (same
 * diff+census two-pass style) — extend this file (don't replace it) as
 * later Phase 27F follow-ups add more evaluation runners.
 *
 * What this guards, concretely (Phase 27F handoff §37):
 *  1. `evaluation_record` is written ONLY through EvaluationCaptureService,
 *     never via a bare `tx.evaluationRecord.create/update/...` elsewhere.
 *  2. Nothing under `apps/api/src/evaluation/` may EVER write active memory
 *     (memory_items / clio_memory), resolve/approve/reject a
 *     MemoryCandidate, create a LearningSignal, or MUTATE a ContextPacket —
 *     a FULL ban with NO exceptions, same strictness as Phase 27E's
 *     telemetry guard and for the same reason: evaluation has no legitimate
 *     reason to ever touch the governed-write surface, and a production
 *     ContextPacket is historical evidence that must stay immutable (§32).
 *  3. Nothing under `apps/api/src/evaluation/` may add a sixth
 *     SteeringLayer — the control projection withholds the five frozen
 *     layers, never invents a new one.
 *  4. `EvaluationRecord` carries a `tenantId` field (auto-covered by
 *     tenant-scope-guard.spec.ts) and no vector/embedding column.
 *  5. The migration's `surface` / `status` / `skip_reason` /
 *     `evaluation_type` CHECK constraints match the frozen vocabularies in
 *     `packages/meriv2-core/src/evaluation/contract.ts` exactly.
 *  6. `EvaluationCaptureService.recordDecision`/`markRunning`/
 *     `markCompleted`/`markFailed` never throw into their caller — an
 *     evaluation must never break the workflow it shadows.
 *  7. `EvaluationModule` never imports `MemoryModule` or `LearningModule` —
 *     the DI graph itself proves this subsystem cannot reach the
 *     governed-write surface, independent of the source-level bans above.
 *  8. No banned confidential-content field name (body/text/content/
 *     transcript/prompt/response/message/summary/note/excerpt/draft/
 *     subject) is ever assigned as a literal object key inside a
 *     `metrics`/`judge`/`cost` value anywhere under
 *     `apps/api/src/evaluation/` — defense-in-depth alongside the runtime
 *     `assertNoConfidentialEvaluationContent` guard.
 *  9. Nothing anywhere in the repo persists an evaluation's judgment/output
 *     as a LearningSignal or MemoryCandidate — the no-AI-evaluates-AI-
 *     feedback-loop invariant (§30). Checked repo-wide, not diff-scoped,
 *     because this is exactly the kind of drift that must never sneak in
 *     from ANY file, not only new evaluation code.
 */

const EVAL_IMPLEMENTATION_PREFIXES = [
  'apps/api/src/evaluation/',
  'packages/meriv2-core/src/evaluation/',
];

/**
 * Surface-specific evaluation RUNNERS (not pure adapters, so they live
 * beside the services they orchestrate — Outreach's/CRM Fill's, matching
 * how OutreachContextPlaneService/ClientProfileFillContextPlaneService also
 * live beside their surfaces rather than under context/).
 *
 * Deliberately checked for the governed-write/LearningSignal-create bans
 * (real risk, and these files have no legitimate reason to touch either)
 * but NOT the banned-content-key census: unlike the pure
 * EVAL_IMPLEMENTATION_PREFIXES directories, these files ALSO build
 * `{subject, body}`-shaped arguments for the real product calls they orchestrate
 * (e.g. `this.verifier.verify({ subject, body, ... })`) — a whole-file key
 * census would flag that legitimate, non-evaluation object literal as a
 * false positive. The runtime `assertNoConfidentialEvaluationContent` guard
 * (enforced on every write, regardless of which file constructed the
 * object) remains the authoritative control for what actually reaches
 * `metrics`/`judge`/`cost`.
 */
const EVAL_RUNNER_FILES = [
  'apps/api/src/engagement/generation/outreach-evaluation.runner.ts',
  'apps/api/src/clients/crm-fill-evaluation.runner.ts',
];

const TEST_SUFFIXES = ['.spec.ts', '.test.ts'];

const BANNED_ADDITION_PATTERNS = [
  /\btx\.evaluationRecord\./,
  /\bprisma\.evaluationRecord\./,
  /\.evaluationRecord\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
];

const FROZEN_STEERING_LAYERS = [
  'firm-identity',
  'firm-playbook',
  'user-voice',
  'client-steering',
  'client-people',
];

const EXPECTED_SURFACES = ['outreach', 'workspace', 'crm_fill', 'meetings', 'strategies', 'meri'];
const EXPECTED_STATUSES = ['pending', 'running', 'completed', 'skipped', 'failed'];
const EXPECTED_SKIP_REASONS = [
  'feature_disabled', 'not_sampled', 'missing_packet', 'missing_context',
  'no_institutional_context', 'unsupported_operation', 'sensitive_operation',
  'insufficient_authoritative_input', 'provider_unavailable', 'budget_exceeded',
];
const EXPECTED_EVALUATION_TYPES = ['institutional_context_ablation'];

/** FULL ban, no exceptions — evaluation has no legitimate reason to ever reach the governed-write surface. */
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
  // ContextPacket may only ever be READ (by id) — never mutated. create is
  // also banned (evaluation never mints a new "real" packet); the control
  // projection is a disposable in-memory object, never a Prisma write.
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

function isEvalImplementationFile(file) {
  return EVAL_IMPLEMENTATION_PREFIXES.some((prefix) => file.startsWith(prefix)) || EVAL_RUNNER_FILES.includes(file);
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

// ── 1. Diff guard ────────────────────────────────────────────────────────
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

    if (!isEvalImplementationFile(currentFile)) {
      for (const pattern of BANNED_ADDITION_PATTERNS) {
        if (pattern.test(added)) {
          fail(
            `${currentFile}: added line bypasses EvaluationCaptureService — direct evaluation_record table access outside apps/api/src/evaluation/.\n  ${added.trim()}`,
          );
        }
      }
    } else if (!isCommentLine(added)) {
      for (const pattern of BANNED_GOVERNED_WRITE_SYMBOLS) {
        if (pattern.test(added)) {
          fail(
            `${currentFile}: added line inside evaluation references the GOVERNED-WRITE surface — evaluation must never mutate active memory, resolve candidates, or mutate ContextPackets.\n  ${added.trim()}`,
          );
        }
      }
      for (const pattern of BANNED_LEARNING_SIGNAL_CREATE_SYMBOLS) {
        if (pattern.test(added)) {
          fail(
            `${currentFile}: added line inside evaluation may CREATE a LearningSignal — evaluation may only read an existing signal's id.\n  ${added.trim()}`,
          );
        }
      }
    }
  }
}
if (failures === 0) ok('diff-scoped bypass/governed-write check passed');

// ── 2. Repo-wide census: every direct evaluation_record reference outside
// the implementation directories (diff-blind spot).
const allTsFiles = listTrackedFiles(/\.(ts|tsx)$/);
const censusFailures = [];
for (const file of allTsFiles) {
  if (isEvalImplementationFile(file) || isTestFile(file)) continue;
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
    fail(`${file}: references evaluation_record directly, outside apps/api/src/evaluation/ (repo-wide census).`);
  }
} else {
  ok('repo-wide evaluation_record table census: zero out-of-module consumers');
}

// ── 2b. Repo-wide census of CURRENT content of every evaluation
// implementation file — governed-write/LearningSignal-create bans with zero
// exceptions (not diff-scoped, so it also catches pre-existing drift).
const evalImplFiles = [...listTrackedFiles(/\.ts$/), ...listTrackedFiles(/\.tsx$/)].filter(
  (f) => isEvalImplementationFile(f) && !isTestFile(f),
);
let governedWriteCensusFailures = 0;
let signalCreateCensusFailures = 0;
let contentKeyCensusFailures = 0;
for (const file of evalImplFiles) {
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
  // Content-key census excludes EVAL_RUNNER_FILES — see their doc comment:
  // those files also build legitimate `{subject, body}`-shaped arguments for
  // the real product calls they orchestrate, which this whole-file census
  // cannot distinguish from a field actually reaching an EvaluationRecord.
  if (EVAL_RUNNER_FILES.includes(file)) continue;
  for (const key of BANNED_CONTENT_KEYS) {
    const keyPattern = new RegExp(`[\\{,]\\s*['"]?${key}['"]?\\s*:`, 'i');
    if (keyPattern.test(code)) {
      fail(`${file}: assigns a banned content-shaped key "${key}:" — an evaluation record must never carry a body/text/content/transcript/prompt/response/message/summary/note/excerpt/draft/subject field.`);
      contentKeyCensusFailures += 1;
    }
  }
}
if (governedWriteCensusFailures === 0 && signalCreateCensusFailures === 0 && contentKeyCensusFailures === 0) {
  ok('repo-wide evaluation-implementation census: no governed-write reference, no LearningSignal creation, no banned content-shaped key');
}

// ── 3. Schema shape: tenantId present, no vector/embedding column.
const schemaPath = 'apps/api/prisma/schema.prisma';
let schema = '';
try {
  schema = readFileSync(schemaPath, 'utf8');
} catch (error) {
  fail(`could not read ${schemaPath}: ${error.message}`);
}
{
  const modelMatch = schema.match(/model EvaluationRecord \{([\s\S]*?)\n\}/);
  if (!modelMatch) {
    fail(`${schemaPath}: model EvaluationRecord not found`);
  } else {
    const body = modelMatch[1];
    if (!/tenantId\s+String/.test(body)) {
      fail('EvaluationRecord model has no tenantId field — would NOT be auto-covered by the tenant-scope guard.');
    } else {
      ok('EvaluationRecord.tenantId present — auto-covered by PrismaService tenant-scope + tenant-scope-guard.spec.ts');
    }
    if (/@db\.Vector|Unsupported\("vector"\)|pgvector/i.test(body)) {
      fail('EvaluationRecord model appears to declare a vector/embedding column — a second vector database is out of scope for Phase 27F.');
    } else {
      ok('EvaluationRecord model has no vector/embedding column');
    }
  }
}

// ── 4. Migration CHECK constraints match the frozen vocabularies exactly.
const migrationFiles = listTrackedFiles(/migration\.sql$/).filter((f) => f.includes('phase27f_evaluation'));
if (!migrationFiles.length) {
  fail('no phase27f_evaluation migration.sql found');
} else {
  const sql = readFileSync(migrationFiles[0], 'utf8');
  checkVocabulary(sql, migrationFiles[0], 'surface(?!_)', EXPECTED_SURFACES, 'the six frozen QualityTelemetrySurface values');
  checkVocabulary(sql, migrationFiles[0], 'status', EXPECTED_STATUSES, 'the frozen EvaluationStatus vocabulary');
  checkVocabulary(sql, migrationFiles[0], 'skip_reason', EXPECTED_SKIP_REASONS, 'the frozen EvaluationSkipReason vocabulary');
  checkVocabulary(sql, migrationFiles[0], 'evaluation_type', EXPECTED_EVALUATION_TYPES, 'the frozen EvaluationType vocabulary');
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

// ── 5. recordDecision / markRunning / markCompleted / markFailed never throw.
const capturePath = 'apps/api/src/evaluation/evaluation-capture.service.ts';
let captureSource = '';
try {
  captureSource = readFileSync(capturePath, 'utf8');
} catch (error) {
  fail(`could not read ${capturePath}: ${error.message}`);
}
if (captureSource) {
  const recordMethodMatch = captureSource.match(/async recordDecision\([\s\S]*?\{([\s\S]*?)\n  \}\n/);
  if (!recordMethodMatch) {
    fail(`${capturePath}: could not locate recordDecision method body`);
  } else {
    const body = recordMethodMatch[1];
    if (!/return\s*\{\s*status:\s*'disabled'\s*\}/.test(body)) {
      fail(`${capturePath}: recordDecision no longer returns the 'disabled' kill-switch result — check the flag guard is still first.`);
    }
    if (!/try\s*\{[\s\S]*validate\(input\)[\s\S]*\}\s*catch/.test(body)) {
      fail(`${capturePath}: recordDecision's validate(input)+write path is not wrapped in a single try/catch — a validation or DB error could throw into the caller.`);
    } else {
      ok('recordDecision wraps validate()+write in one try/catch after the kill-switch check — never throws into its caller');
    }
  }
  for (const method of ['markRunning', 'markCompleted', 'markFailed']) {
    const methodRe = new RegExp(`async ${method}\\([\\s\\S]*?\\{([\\s\\S]*?)\\n  \\}\\n`);
    const match = captureSource.match(methodRe);
    if (!match) {
      fail(`${capturePath}: could not locate ${method} method body`);
      continue;
    }
    if (!/try\s*\{[\s\S]*\}\s*catch/.test(match[1])) {
      fail(`${capturePath}: ${method}'s body is not wrapped in try/catch — a DB error could throw into its caller.`);
    } else {
      ok(`${method} wraps its body in try/catch — never throws into its caller`);
    }
  }
}

// ── 6. DI graph: EvaluationModule never imports MemoryModule or LearningModule.
const modulePath = 'apps/api/src/evaluation/evaluation.module.ts';
let moduleSource = '';
try {
  moduleSource = readFileSync(modulePath, 'utf8');
} catch (error) {
  fail(`could not read ${modulePath}: ${error.message}`);
}
if (moduleSource) {
  const moduleCode = moduleSource.split('\n').filter((line) => !isCommentLine(line)).join('\n');
  if (/\bMemoryModule\b|\bLearningModule\b/.test(moduleCode)) {
    fail(`${modulePath}: imports MemoryModule or LearningModule — the DI graph itself must prove evaluation cannot reach the governed-write surface.`);
  } else {
    ok('EvaluationModule imports neither MemoryModule nor LearningModule');
  }
}

// ── 7. No sixth SteeringLayer introduced anywhere under the evaluation
// implementation directories.
{
  const bannedSixthLayerFailures = [];
  for (const file of evalImplFiles) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const layerLiterals = [...content.matchAll(/['"]([a-z][a-z-]*)['"]\s*(?:as\s+SteeringLayer)/g)].map((m) => m[1]);
    for (const literal of layerLiterals) {
      if (!FROZEN_STEERING_LAYERS.includes(literal)) {
        bannedSixthLayerFailures.push(`${file}: layer literal "${literal}" cast as SteeringLayer is not one of the five frozen values.`);
      }
    }
  }
  if (bannedSixthLayerFailures.length) {
    for (const message of bannedSixthLayerFailures) fail(message);
  } else {
    ok('no sixth SteeringLayer literal found under the evaluation implementation directories');
  }
}

// ── 8. Repo-wide: an evaluation result/judgment must never become a
// LearningSignal or MemoryCandidate (§30). Checked across the WHOLE repo,
// not just the evaluation directories, because the violation this guards
// against is a caller elsewhere feeding evaluation output INTO the
// governed-write surface.
{
  const feedbackLoopFailures = [];
  for (const file of allTsFiles) {
    if (isTestFile(file)) continue;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (/evaluationRecord[\s\S]{0,200}(LearningSignalCaptureService|memoryCandidate\.(create|update)|MemoryCandidateService)/.test(content)) {
      feedbackLoopFailures.push(file);
    }
  }
  if (feedbackLoopFailures.length) {
    for (const file of new Set(feedbackLoopFailures)) {
      fail(`${file}: appears to feed an EvaluationRecord into LearningSignal/MemoryCandidate creation — an AI-evaluates-AI feedback loop into memory is banned with no exceptions (§30).`);
    }
  } else {
    ok('repo-wide: no evaluation-record-to-memory feedback loop found');
  }
}

if (failures > 0) {
  console.error(`\n${failures} evaluation architecture guard failure(s).`);
  process.exit(1);
} else {
  console.log('\nevaluation architecture guard passed.');
}
