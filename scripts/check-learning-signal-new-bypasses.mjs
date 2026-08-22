#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || 'origin/main';

/**
 * Phase 27A/27B/27C architecture guard for `learning_signal`
 * (LearningSignal) and its candidate-generation + conflict-detection
 * extensions.
 *
 * Modeled on the two existing guard styles in this repo — the diff+census
 * pattern from `check-context-plane-new-bypasses.mjs`, and the
 * schema-derived model list from `apps/api/src/prisma/tenant-scope-guard.spec.ts`
 * — rather than inventing a third style. Extend this file (don't replace it)
 * as later Phase 27 sub-phases (governance integration, ...) add their own
 * tables/services.
 *
 * What this guards, concretely:
 *  1. `learning_signal` is written ONLY through LearningSignalCaptureService,
 *     never via a bare `tx.learningSignal.create/update/upsert` elsewhere.
 *  2. Nothing under `apps/api/src/learning/` EVER *writes* active memory
 *     (memory_items / clio_memory) — no signal or candidate can become
 *     active memory from inside this directory, in any Phase 27 sub-phase.
 *     This is the hard architecture invariant that survives across
 *     sub-phases. As of 27C this is a WRITE-verb ban, not a bare-mention
 *     ban: `LearningSignalMemoryConflictService` legitimately READS
 *     `memory_items` (joined against `context_embeddings`) to detect a
 *     candidate's relationship to existing active memory — detection is not
 *     promotion. `MemoryStoreService` (the service, not a raw table
 *     reference) stays a full, unconditional ban with no read/write
 *     distinction: there is no legitimate reason for anything under this
 *     directory to import the whole store service just to read one row.
 *  3. The 27A-only ban is narrower now that 27B exists: everything under
 *     `apps/api/src/learning/` is still banned from the governed-CANDIDATE
 *     write surface (memory_candidate / MemoryCandidateService) EXCEPT the
 *     one file whose entire canonical purpose is exactly that —
 *     LearningSignalCandidateService (Phase 27B handoff §3: "candidate
 *     generation should consume the canonical signals" — it is the
 *     designated consumer). Every other file in the directory, including
 *     the 27A adapters, remains fully banned: adapters must only ever
 *     produce LearningSignals, never write candidates directly.
 *  4. The LearningSignal Prisma model carries a `tenantId` field (so it is
 *     automatically covered by PrismaService's tenant-scope extension and
 *     tenant-scope-guard.spec.ts) and no vector/embedding column (no second
 *     vector database).
 *  5. `proposed_memory_layer`'s CHECK constraint in the migration lists
 *     exactly the five frozen SteeringLayer values — no sixth layer.
 *  6. Phase 27B additions: the never-auto-commit rule
 *     (`memory.learning_signal.requires_review`) exists in
 *     memory-candidate-rules.ts and fires on outcome WARN, and the
 *     candidate-generation idempotency guard (a unique index scoped to
 *     `source_type = 'learning_signal_capture'`) exists in the Phase 27B
 *     migration.
 *  7. Phase 27C addition: `LearningSignalMemoryConflictService` (and ONLY
 *     that file) may reference `memory_items` — but never a mutation verb
 *     against it, and never `ImmutableMemoryVersionService` /
 *     `MemoryConflictService` (the human-driven correction/contradiction
 *     services) — 27C detects and flags on the CANDIDATE only, it never
 *     drives the existing services that mutate an active item's own
 *     conflict state.
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
 * ACTIVE memory WRITE surface — banned everywhere under
 * apps/api/src/learning/, with NO file exceptions, in every Phase 27
 * sub-phase. Verb-scoped (not a bare-mention ban) since 27C: a read-only
 * SELECT/JOIN against memory_items is legitimate detection work
 * (LearningSignalMemoryConflictService), never promotion.
 * `MemoryStoreService` stays a full bare-symbol ban — importing that whole
 * service implies write capability with no read-only-only use case worth
 * carving out.
 */
const BANNED_ACTIVE_MEMORY_SYMBOLS = [
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+memory_items\b/i,
  /\bmemoryItem\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+clio_memory\b/i,
  /\bclioMemory\.(create|update|upsert|delete|deleteMany|updateMany)\(/,
  /\bMemoryStoreService\b/,
  // 27C detects and flags on the CANDIDATE only — it must never drive the
  // existing services that mutate an active item's OWN conflict/version
  // state, even though those services technically write memory_candidate
  // too (which is why this isn't just folded into the candidate-surface
  // ban below).
  /\bImmutableMemoryVersionService\b/,
  /\bMemoryConflictService\b/,
];

/**
 * The governed-CANDIDATE write surface. Banned everywhere under
 * apps/api/src/learning/ EXCEPT `CANDIDATE_GENERATION_FILE` below — that
 * file's entire canonical purpose is calling into this surface (Phase 27B).
 * Every 27A adapter and every other file remains fully banned: adapters
 * produce signals only, never candidates.
 */
const BANNED_CANDIDATE_SURFACE_SYMBOLS = [
  /\bmemory_candidate\b/,
  /\bMemoryCandidateService\b/,
  /\bmemoryCandidate\s*:\s*prisma/, // defensive: a raw prisma.memoryCandidate access
];

/** The one Phase 27B file allowed to reference the candidate write surface. */
const CANDIDATE_GENERATION_FILE = 'apps/api/src/learning/learning-signal-candidate.service.ts';

function isApprovedCandidateGenerationFile(file) {
  return file === CANDIDATE_GENERATION_FILE;
}

/** Explicitly reviewed exceptions. Each stops being valid the moment the line changes. */
const APPROVED_ADAPTER_LINES = [];

function isApproved(file, line) {
  return APPROVED_ADAPTER_LINES.some((entry) => entry.file === file && entry.line === line.trim());
}

/**
 * The promotion-surface ban (unlike the outside-module bypass ban) is meant
 * to catch real code — an import, a call, a raw table reference — not this
 * file's own JSDoc explaining WHY those symbols are banned. Skip standard
 * comment-continuation lines (this codebase's JSDoc style throughout).
 */
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
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
    } else if (!isCommentLine(added)) {
      for (const pattern of BANNED_ACTIVE_MEMORY_SYMBOLS) {
        if (pattern.test(added)) {
          fail(
            `${currentFile}: added line inside the learning implementation references an ACTIVE memory surface — no signal or candidate may ever become active memory from this directory.\n  ${added.trim()}`,
          );
        }
      }
      if (!isApprovedCandidateGenerationFile(currentFile)) {
        for (const pattern of BANNED_CANDIDATE_SURFACE_SYMBOLS) {
          if (pattern.test(added)) {
            fail(
              `${currentFile}: added line references the governed-candidate write surface, but only ${CANDIDATE_GENERATION_FILE} is approved to do that (Phase 27B's designated LearningSignal → candidate path).\n  ${added.trim()}`,
            );
          }
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

// ── 3b. Repo-wide census of the CURRENT content of every learning
// implementation file (not diff-scoped, so it also catches drift from a
// change landed before this guard existed, or from a future edit whose
// diff base predates it) — the active-memory ban with zero exceptions, and
// the candidate-surface ban with exactly one approved file.
const learningImplFiles = [...listTrackedFiles(/\.ts$/), ...listTrackedFiles(/\.tsx$/)].filter(
  (f) => isLearningImplementationFile(f) && !isTestFile(f),
);
let activeMemoryCensusFailures = 0;
let candidateSurfaceCensusFailures = 0;
for (const file of learningImplFiles) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const codeLines = content.split('\n').filter((line) => !isCommentLine(line));
  const code = codeLines.join('\n');
  for (const pattern of BANNED_ACTIVE_MEMORY_SYMBOLS) {
    if (pattern.test(code)) {
      fail(`${file}: references an ACTIVE memory surface (repo-wide census, not diff-scoped) — banned with no exceptions.`);
      activeMemoryCensusFailures += 1;
    }
  }
  if (!isApprovedCandidateGenerationFile(file)) {
    for (const pattern of BANNED_CANDIDATE_SURFACE_SYMBOLS) {
      if (pattern.test(code)) {
        fail(
          `${file}: references the governed-candidate write surface (repo-wide census) — only ${CANDIDATE_GENERATION_FILE} is approved.`,
        );
        candidateSurfaceCensusFailures += 1;
      }
    }
  }
}
if (activeMemoryCensusFailures === 0 && candidateSurfaceCensusFailures === 0) {
  ok('repo-wide learning-implementation census: no active-memory WRITE anywhere, no candidate-surface reference outside the one approved 27B file');
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

// ── 6. Phase 27B: the never-auto-commit rule must exist and be positioned
// so it wins first-match regardless of scope. A rule that only checks
// `sourceKind === 'learning_signal'` but got reordered after
// `memory.personal.auto_commit` would silently let a personal-scope
// learning-signal candidate auto-commit — check the STRING ORDER in the
// rules file, not just presence.
const rulesPath = 'apps/api/src/memory/memory-candidate-rules.ts';
let rulesSource = '';
try {
  rulesSource = readFileSync(rulesPath, 'utf8');
} catch (error) {
  fail(`could not read ${rulesPath}: ${error.message}`);
}
const learningRuleIdx = rulesSource.indexOf("id: 'memory.learning_signal.requires_review'");
const personalAutoCommitIdx = rulesSource.indexOf("id: 'memory.personal.auto_commit'");
if (learningRuleIdx === -1) {
  fail(`${rulesPath}: memory.learning_signal.requires_review rule not found — a learning-signal-derived candidate could fall through to auto-commit.`);
} else if (personalAutoCommitIdx !== -1 && learningRuleIdx > personalAutoCommitIdx) {
  fail(`${rulesPath}: memory.learning_signal.requires_review is positioned AFTER memory.personal.auto_commit — first-match-wins would let a personal-scope learning-signal candidate auto-commit.`);
} else {
  ok('memory.learning_signal.requires_review exists and precedes memory.personal.auto_commit (never auto-commits regardless of scope)');
}

// ── 7. Phase 27B: candidate-generation idempotency guard exists — a unique
// index scoped to source_type = 'learning_signal_capture', so the same
// signal can never produce two memory_candidate rows.
const candidateGenerationMigrations = listTrackedFiles(/migration\.sql$/).filter((f) =>
  f.includes('learning_signal_candidate_generation'),
);
if (!candidateGenerationMigrations.length) {
  fail('no learning_signal_candidate_generation migration.sql found');
} else {
  const sql = readFileSync(candidateGenerationMigrations[0], 'utf8');
  if (!/CREATE UNIQUE INDEX[\s\S]*?learning_signal_capture/.test(sql)) {
    fail(`${candidateGenerationMigrations[0]}: no unique index scoped to source_type = 'learning_signal_capture' found — candidate generation would not be idempotent at the database level.`);
  } else {
    ok("candidate-generation idempotency guard present: unique index scoped to source_type = 'learning_signal_capture'");
  }
  if (!/eligibility IN \(/.test(sql) || !/negative_feedback_only/.test(sql) || !/blocked_by_policy/.test(sql)) {
    fail(`${candidateGenerationMigrations[0]}: learning_signal_candidate_outcome eligibility CHECK constraint looks incomplete.`);
  } else {
    ok('learning_signal_candidate_outcome eligibility CHECK constraint present');
  }
}

// ── 8. Phase 27C: the conflict-detection service exists, is genuinely
// read-only (a SELECT, not a stub), and the active-item mutation it must
// never touch is verifiably absent from it.
const conflictServicePath = 'apps/api/src/learning/learning-signal-memory-conflict.service.ts';
let conflictServiceSource = '';
try {
  conflictServiceSource = readFileSync(conflictServicePath, 'utf8');
} catch (error) {
  fail(`could not read ${conflictServicePath}: ${error.message}`);
}
if (conflictServiceSource) {
  if (!/\bmemory_items\b/.test(conflictServiceSource) || !/SELECT/i.test(conflictServiceSource)) {
    fail(`${conflictServicePath}: does not appear to query memory_items at all — is Phase 27C's conflict-detection step still wired up?`);
  } else if (/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+memory_items\b/i.test(conflictServiceSource)) {
    fail(`${conflictServicePath}: contains a memory_items MUTATION — this file must be read-only.`);
  } else {
    ok('learning-signal-memory-conflict.service.ts queries memory_items read-only (SELECT present, no mutation verb)');
  }
}

// ── 9. Phase 27C: MemoryCandidate's conflict-lineage fields
// (contradicts_memory_item_id / conflict_status) are actually wired into
// proposeSaveMemory's INSERT — otherwise LearningSignalCandidateService's
// conflict flags would silently no-op.
const candidateServicePath = 'apps/api/src/memory/memory-candidate.service.ts';
let candidateServiceSource = '';
try {
  candidateServiceSource = readFileSync(candidateServicePath, 'utf8');
} catch (error) {
  fail(`could not read ${candidateServicePath}: ${error.message}`);
}
if (candidateServiceSource) {
  if (
    !/contradicts_memory_item_id/.test(candidateServiceSource) ||
    !/conflict_status/.test(candidateServiceSource)
  ) {
    fail(`${candidateServicePath}: proposeSaveMemory's INSERT no longer sets contradicts_memory_item_id/conflict_status — Phase 27C's conflict flags would silently no-op.`);
  } else {
    ok('proposeSaveMemory INSERT sets contradicts_memory_item_id/conflict_status (Phase 27C conflict flags are live, not a no-op)');
  }
}

if (failures > 0) {
  console.error(`\n${failures} learning-signal architecture guard failure(s).`);
  process.exit(1);
} else {
  console.log('\nlearning-signal architecture guard passed.');
}
