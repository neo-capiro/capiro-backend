/** @cleanup-smoke noArgsExit=2 */
/** One named REVIEW re-extraction. Preview is read-only; publication is never performed. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ReextractionRequestV1 } from '../src/defense-budget/governed-reextraction/reextraction-repository-v1.js';

export type ReextractionCliOptionsV1 =
  | { mode: 'status'; operationId: string }
  | {
      mode: 'abandon_expired'; commit: boolean; operationId: string;
      environment: string; actor: string; reasonFile: string; confirm?: string;
    }
  | {
      mode: 'preview' | 'commit';
      environment: string;
      confirm?: string;
      reasonFile: string;
      request: Omit<ReextractionRequestV1, 'reason'>;
    };

class ReextractionUsageErrorV1 extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const VALUE_FLAGS = new Set([
  '--operation-id', '--outbox-row-id', '--old-candidate-id', '--expected-old-verification-run-id',
  '--expected-source-sha256', '--expected-old-extraction-artifact-sha256', '--actor', '--reason-file',
  '--expected-release-revision', '--env', '--confirm',
]);

export function parseReextractionArgsV1(argv: string[]): ReextractionCliOptionsV1 {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!VALUE_FLAGS.has(flag) && flag !== '--commit' && flag !== '--status' && flag !== '--abandon-expired') {
      throw new ReextractionUsageErrorV1(`Unknown argument: ${flag}`);
    }
    if (values.has(flag)) throw new ReextractionUsageErrorV1(`Duplicate argument: ${flag}`);
    if (flag === '--commit' || flag === '--status' || flag === '--abandon-expired') { values.set(flag, 'true'); continue; }
    const value = argv[++i];
    if (!value?.trim() || value.startsWith('--')) throw new ReextractionUsageErrorV1(`${flag} requires a value`);
    values.set(flag, value.trim());
  }
  const required = (flag: string, pattern?: RegExp): string => {
    const value = values.get(flag);
    if (!value || (pattern && !pattern.test(value))) throw new ReextractionUsageErrorV1(`${flag} is missing or invalid`);
    return value;
  };
  const operationId = required('--operation-id', UUID);
  if (values.has('--status')) {
    if (values.size !== 2) throw new ReextractionUsageErrorV1('--status accepts only --operation-id');
    return { mode: 'status', operationId };
  }
  const commit = values.has('--commit');
  if (!commit && values.has('--confirm')) throw new ReextractionUsageErrorV1('--confirm requires --commit');
  const environment = required('--env');
  if (commit && required('--confirm') !== environment) throw new ReextractionUsageErrorV1('--confirm must exactly match --env');
  const actor = required('--actor');
  if (actor.length > 256) throw new ReextractionUsageErrorV1('--actor must not exceed 256 characters');
  if (values.has('--abandon-expired')) {
    const allowed = new Set(['--abandon-expired', '--operation-id', '--env', '--actor', '--reason-file', '--commit', '--confirm']);
    if ([...values.keys()].some(key => !allowed.has(key))) {
      throw new ReextractionUsageErrorV1('--abandon-expired accepts only operation, environment, actor, reason file and commit confirmation');
    }
    return {
      mode: 'abandon_expired', commit, operationId, environment, actor,
      reasonFile: required('--reason-file'), confirm: values.get('--confirm'),
    };
  }
  return {
    mode: commit ? 'commit' : 'preview', environment, confirm: values.get('--confirm'),
    reasonFile: required('--reason-file'),
    request: {
      operationId, outboxRowId: required('--outbox-row-id', UUID), oldCandidateId: required('--old-candidate-id', UUID),
      expectedOldVerificationRunId: required('--expected-old-verification-run-id', UUID),
      expectedSourceSha256: required('--expected-source-sha256', SHA256),
      expectedOldExtractionArtifactSha256: required('--expected-old-extraction-artifact-sha256', SHA256),
      actor, releaseRevision: required('--expected-release-revision', REVISION),
    },
  };
}

/** Validate before constructing any database or parser client. Status is intentionally independent. */
export function assertReextractionEnvironmentV1(options: ReextractionCliOptionsV1, env: NodeJS.ProcessEnv): void {
  if (options.mode === 'status') return;
  const actualEnvironment = env.APP_ENV?.trim() || env.NODE_ENV?.trim();
  if (!actualEnvironment || options.environment !== actualEnvironment) {
    throw new ReextractionUsageErrorV1('--env must exactly match actual APP_ENV (or NODE_ENV when APP_ENV is unset)');
  }
  if (options.mode !== 'abandon_expired') {
    const revision = env.GIT_SHA?.trim();
    if (!revision || !REVISION.test(revision) || revision !== options.request.releaseRevision) {
      throw new ReextractionUsageErrorV1('GIT_SHA must be a real 40-character revision matching --expected-release-revision');
    }
  }
  const commits = options.mode === 'commit' || (options.mode === 'abandon_expired' && options.commit);
  if (commits && options.confirm !== actualEnvironment) {
    throw new ReextractionUsageErrorV1('--commit requires --confirm matching the actual environment');
  }
}

/** Hash configuration, never credentials or their hashes. Key order/outer whitespace are immaterial. */
export function reextractionRuntimeConfigSha256V1(env: NodeJS.ProcessEnv): string {
  const secretName = /(?:PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|DATABASE_URL|AUTHORIZATION)/i;
  const settings: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (!/^(?:BUDGET|DEFENSE_BUDGET)_/.test(key) || secretName.test(key)) continue;
    const value = env[key]?.trim();
    if (value) settings[key] = value;
  }
  settings.AWS_REGION = env.AWS_REGION?.trim() || 'us-east-1';
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

/** A missing/unreadable path is an invalid-configuration usage error (exit 2), never a raw ENOENT (exit 1). */
function statOrUsageError(path: string, message: string): Stats {
  try {
    return statSync(path);
  } catch {
    throw new ReextractionUsageErrorV1(message);
  }
}

function assertCommitParserRuntimeV1(env: NodeJS.ProcessEnv): void {
  const bucket = env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET?.trim();
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new ReextractionUsageErrorV1('Commit requires BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET');
  }
  const root = env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT?.trim();
  const project = env.DEFENSE_BUDGET_PARSER_PROJECT_DIR?.trim();
  if (!root || !isAbsolute(root) || !project || !isAbsolute(project)) {
    throw new ReextractionUsageErrorV1('Commit requires absolute BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT and DEFENSE_BUDGET_PARSER_PROJECT_DIR');
  }
  if (!statOrUsageError(project, 'Parser project is not a directory').isDirectory()) {
    throw new ReextractionUsageErrorV1('Parser project is not a directory');
  }
  for (const relative of ['pyproject.toml', 'uv.lock', '.venv/bin/capiro-defense-budget-parser']) {
    if (!statOrUsageError(join(project, relative), `Parser runtime is missing ${relative}`).isFile()) {
      throw new ReextractionUsageErrorV1(`Parser runtime is missing ${relative}`);
    }
  }
}

export function reextractionExitCodeV1(result: {
  outcome: string;
  operation?: { terminal: Record<string, unknown> | null } | null;
}): number {
  if (result.outcome === 'preview') return 0;
  if (result.outcome !== 'completed') return 3;
  const decision = result.operation?.terminal?.verifierDecision;
  if (decision === 'REJECT') return 4;
  return decision === 'PASS' || decision === 'REVIEW' ? 0 : 3;
}

export async function mainReextractionV1(argv = process.argv.slice(2)): Promise<number> {
  const options = parseReextractionArgsV1(argv);
  assertReextractionEnvironmentV1(options, process.env);
  let reason = '';
  if (options.mode !== 'status') {
    // Read operator rationale exactly once, before any database access.
    if (statOrUsageError(options.reasonFile, `--reason-file does not exist or is not readable: ${options.reasonFile}`).size > 64_000) {
      throw new ReextractionUsageErrorV1('Reason file is too large');
    }
    reason = readFileSync(options.reasonFile, 'utf8').trim();
    if (!reason || reason.length > 16_000) throw new ReextractionUsageErrorV1('Reason must contain 1 to 16000 characters');
    if (options.mode === 'commit') assertCommitParserRuntimeV1(process.env);
  }
  const { PrismaClient } = await import('@prisma/client');
  const { createReextractionRepositoryV1, checkpointReextractionVerificationV1 } = await import('../src/defense-budget/governed-reextraction/reextraction-repository-v1.js');
  const prisma = new PrismaClient();
  try {
    const repository = createReextractionRepositoryV1(prisma);
    if (options.mode === 'status') {
      const operation = await repository.read(options.operationId);
      console.log(JSON.stringify({ outcome: operation ? 'status' : 'not_found', operation, publication: 'not_performed' }, null, 2));
      return operation ? 0 : 3;
    }
    if (options.mode === 'abandon_expired') {
      const result = await repository.abandonExpired(options.operationId, options.actor, reason, { commit: options.commit });
      const exitCode = result.outcome === 'ineligible' ? 3 : 0;
      console.log(JSON.stringify({
        mode: options.mode, commit: options.commit, environment: options.environment,
        ...result, publication: 'not_performed', exitCode,
        nextAction: result.outcome === 'abandoned'
          ? 'Expired operation closed with its evidence retained. Inspect current source and review bindings before creating a new named operation.'
          : result.outcome === 'preview'
            ? 'Eligible for explicit closure; preview changed nothing. Commit requires matching environment confirmation.'
            : 'Only a failed or expired running operation can be closed; inspect its current durable status.',
      }, null, 2));
      return exitCode;
    }
    const { ReviewCandidateReextractionV1 } = await import('../src/defense-budget/governed-reextraction/reextract-review-candidate-v1.js');
    const { resolveReextractionTargetV1 } = await import('../src/defense-budget/governed-reextraction/reextraction-target-v1.js');
    const { S3SourceDocumentArchiveReadAdapter } = await import('../src/defense-budget/s3-source-document-archive-read.adapter.js');
    const { runParserHandoffForSourceDocument } = await import('../src/defense-budget/parser-router/source-document-parser-handoff.js');
    const archive = new S3SourceDocumentArchiveReadAdapter();
    try {
      const service = new ReviewCandidateReextractionV1({
        repository, resolveTarget: request => resolveReextractionTargetV1(prisma, request), archive,
        parse: runParserHandoffForSourceDocument,
        persistenceFence: context => (tx, identity, candidateId, verificationRunId) =>
          checkpointReextractionVerificationV1(tx, context, identity, candidateId, verificationRunId),
        runtimeConfigSha256: reextractionRuntimeConfigSha256V1(process.env),
        parserArtifactRoot: process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT?.trim() ?? '',
      });
      const result = await service.run({ ...options.request, reason }, { commit: options.mode === 'commit' });
      const exitCode = reextractionExitCodeV1(result);
      console.log(JSON.stringify({ mode: options.mode, environment: options.environment, ...result, exitCode }, null, 2));
      return exitCode;
    } finally { await archive.destroy(); }
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) {
  void mainReextractionV1().then(code => { process.exitCode = code; }).catch(error => {
    if (error instanceof ReextractionUsageErrorV1) {
      console.error('Usage: reextract-defense-budget-candidate-v1 --operation-id <uuid> --status | --operation-id <uuid> --outbox-row-id <uuid> --old-candidate-id <uuid> --expected-old-verification-run-id <uuid> --expected-source-sha256 <sha> --expected-old-extraction-artifact-sha256 <sha> --actor <id> --reason-file <path> --expected-release-revision <sha> --env <env> [--commit --confirm <env>]');
    }
    console.error(JSON.stringify({
      outcome: 'failed', publication: 'not_performed',
      error: error instanceof Error ? error.message : String(error),
      nextAction: 'Inspect --operation-id <uuid> --status before retrying a committed operation.',
    }));
    process.exitCode = error instanceof ReextractionUsageErrorV1 ? 2 : 1;
  });
}
