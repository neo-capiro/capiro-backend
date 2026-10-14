/**
 * PE / SOC2 migration guards (Phase K / closeout Phase 8) — pure checks.
 *
 * Permanent rules:
 *  1. Deploy path may run `prisma migrate deploy` only (never resolve / reset).
 *     The two approved explicit operator recovery arms have a separate, closed
 *     source protocol. They are never deploy/replay recovery.
 *  2. No entrypoint / script may hand-edit `_prisma_migrations`.
 *  3. Validate + generate are required offline gates before replay evidence.
 *  4. Clean migrate replay and upgrade replay are operator steps; this module
 *     encodes how to interpret their results (exit codes / forbidden strings).
 */
import { createHash } from 'node:crypto';

export type MigrationGuardSeverity = 'blocker' | 'ok';

export interface EntrypointSourceSnapshot {
  /** Relative path for messages. */
  path: string;
  /** Full file contents (CRLF normalized recommended). */
  source: string;
}

export interface MigrationGuardFinding {
  code: string;
  severity: MigrationGuardSeverity;
  message: string;
  path?: string;
}

export interface MigrationGuardResult {
  ok: boolean;
  findings: MigrationGuardFinding[];
}

const FORBIDDEN_MIGRATION_HISTORY_PATTERNS: Array<{ code: string; re: RegExp; label: string }> = [
  {
    code: 'hand_edit_prisma_migrations_table',
    re: /_prisma_migrations/,
    label: 'references _prisma_migrations (hand-edit / auto-resolve hazard)',
  },
  {
    code: 'prisma_migrate_resolve',
    re: /prisma[^\n]*migrate\s+resolve/,
    label: 'contains prisma migrate resolve',
  },
  {
    code: 'auto_rolled_back_at',
    re: /rolled_back_at\s*=\s*NOW\s*\(/i,
    label: 'auto-sets rolled_back_at = NOW()',
  },
];

/**
 * Approved container recovery interface: f06cdced / PR816, required by the later
 * a966a263 Phase A contract. The original envelope is pinned at d70bb972;
 * the successor pins remove only the retired workflow-template seed callers.
 * These are RAW UTF-8 source hashes after CRLF -> LF only, including comments.
 * A caller must not pre-strip comments: text inside multiline shell strings can
 * begin with # without being a shell comment. No runtime/operator authorization
 * or arbitrary shell/interprocedural containment follows from this attestation.
 * Any source-envelope change needs an explicit review of this protocol.
 */
const MANUAL_RECOVERY_SOURCE_SHA256 = {
  'scripts/entrypoint.sh': 'a16c4ebffbb10da7a18a6a38f2f67bd35f39a875fdf4411b7015c395bb26e98d',
  'scripts/entrypoint-legacy.sh': '4f9213850b938f71f1a7955683792c6ded862c4453efe9234ddf40f892ce7d0a',
  'scripts/entrypoint-dispatcher.inc': '1651d7fac414eff859be16039fbce6117782a4611d19894f9e32097dda86e420',
} as const;
const MANUAL_RECOVERY_MODES = ['rolled-back', 'applied'] as const;
type ManualRecoveryMode = (typeof MANUAL_RECOVERY_MODES)[number];

function normalizedRawShellSource(source: string): string {
  return source.replace(/\r\n/g, '\n');
}

function manualRecoveryBranchPattern(mode: ManualRecoveryMode): RegExp {
  return new RegExp(`^  migrate-resolve-${mode}\\)\\n[\\s\\S]*?^    ;;`, 'gm');
}

function expectedManualRecoveryBranch(mode: ManualRecoveryMode): string {
  return [
    `  migrate-resolve-${mode})`,
    '    shift',
    '    if [ -z "${1:-}" ]; then',
    `      echo "Usage: migrate-resolve-${mode} <migration_name>" >&2`,
    '      exit 1',
    '    fi',
    '    compose_database_url',
    `    echo "Running prisma migrate resolve --${mode} $1 (controlled recovery, see runbook)"`,
    `    exec node ./node_modules/prisma/build/index.js migrate resolve --schema=./prisma/schema.prisma --${mode} "$1"`,
    '    ;;',
  ].join('\n');
}

/**
 * Prove precisely the approved three-source envelope and two explicit arms.
 * This is a closed source protocol, not a permissive branch-removal regex or a
 * general shell parser. Full raw-envelope identity prevents hidden commands,
 * rebinding, nested/duplicate cases, fallthrough, reordered guards and helper
 * changes from being accepted because a familiar verb/argv string still exists.
 */
export function inspectApprovedManualMigrationEntrypoints(
  snapshots: readonly EntrypointSourceSnapshot[],
): MigrationGuardResult {
  // Capture primitive values once. Fingerprint, grammar and strict scan must
  // observe the same source even if a caller supplied getter-backed snapshots.
  const sources = snapshots.map((snapshot) => ({ path: snapshot.path, source: snapshot.source }));
  const findings: MigrationGuardFinding[] = [];
  const fail = (message: string, path?: string): void => {
    findings.push({ code: 'manual_migration_source_protocol_unproven', severity: 'blocker', message, path });
  };
  if (sources.length !== 3) {
    fail('manual recovery requires exactly the three approved raw entrypoint snapshots');
  }
  for (const [path, expectedSha256] of Object.entries(MANUAL_RECOVERY_SOURCE_SHA256)) {
    const matching = sources.filter((snapshot) => snapshot.path === path);
    if (matching.length !== 1) {
      fail(`${path}: expected exactly one approved raw source snapshot`, path);
      continue;
    }
    const actualSha256 = createHash('sha256')
      .update(normalizedRawShellSource(matching[0]!.source), 'utf8')
      .digest('hex');
    if (actualSha256 !== expectedSha256) {
      fail(`${path}: raw LF-normalized source differs from the approved manual recovery envelope`, path);
    }
  }
  for (const snapshot of sources) {
    if (!Object.prototype.hasOwnProperty.call(MANUAL_RECOVERY_SOURCE_SHA256, snapshot.path)) {
      fail(`${snapshot.path}: not an approved manual recovery source path`, snapshot.path);
    }
  }
  if (findings.length > 0) return { ok: false, findings };

  const active = normalizedRawShellSource(sources.find((s) => s.path === 'scripts/entrypoint.sh')!.source);
  const selector = /^case "\$\{1:-serve\}" in$/gm;
  if ((active.match(selector) ?? []).length !== 1 || !active.startsWith('#!/bin/sh\n')) {
    fail('scripts/entrypoint.sh: explicit argv selector and shell owner must remain exact', 'scripts/entrypoint.sh');
  }
  for (const mode of MANUAL_RECOVERY_MODES) {
    const branches = active.match(manualRecoveryBranchPattern(mode)) ?? [];
    if (branches.length !== 1 || stripShellComments(branches[0] ?? '') !== expectedManualRecoveryBranch(mode)) {
      fail(`scripts/entrypoint.sh: exact explicit ${mode} recovery arm must remain intact`, 'scripts/entrypoint.sh');
    }
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Strip shell comments (`# …`) so commented educational text does not fail the gate.
 * Does not attempt full shell parsing — adequate for linear entrypoint scripts.
 */
export function stripShellComments(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Entrypoints and deploy helpers must never mutate migration history automatically.
 * Exactly one active path may invoke `migrate deploy` (caller may re-check count).
 */
export function assertNoMigrationHistoryMutation(
  snapshots: readonly EntrypointSourceSnapshot[],
): MigrationGuardResult {
  const sources = snapshots.map((snapshot) => ({ path: snapshot.path, source: snapshot.source }));
  const findings: MigrationGuardFinding[] = [];
  const namesApprovedEntrypoint = sources.some((snapshot) =>
    Object.prototype.hasOwnProperty.call(MANUAL_RECOVERY_SOURCE_SHA256, snapshot.path),
  );
  const manualProtocol = namesApprovedEntrypoint
    ? inspectApprovedManualMigrationEntrypoints(sources)
    : undefined;
  if (manualProtocol && !manualProtocol.ok) findings.push(...manualProtocol.findings);
  for (const snap of sources) {
    const body = stripShellComments(snap.source);
    for (const rule of FORBIDDEN_MIGRATION_HISTORY_PATTERNS) {
      // Only resolve text inside the TWO proven operator arms is confined. All
      // direct history references/rollback edits retain the original strict scan
      // across the entire source. Generic/unproven sources retain every rule.
      let checkedBody = body;
      if (manualProtocol?.ok && snap.path === 'scripts/entrypoint.sh' && rule.code === 'prisma_migrate_resolve') {
        for (const mode of MANUAL_RECOVERY_MODES) {
          checkedBody = checkedBody.replace(manualRecoveryBranchPattern(mode), '');
        }
      }
      if (rule.re.test(checkedBody)) {
        findings.push({
          code: rule.code,
          severity: 'blocker',
          message: `${snap.path}: ${rule.label}`,
          path: snap.path,
        });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

export function countMigrateDeployInvocations(
  snapshots: readonly EntrypointSourceSnapshot[],
): number {
  let n = 0;
  // Count real CLI invocations only — not log/echo prose that mentions the words.
  for (const snap of snapshots) {
    const body = stripShellComments(snap.source);
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('echo ') || trimmed.startsWith('printf ')) continue;
      if (/\bmigrate\s+deploy\b/.test(trimmed) && /\bprisma\b/.test(trimmed)) {
        n += 1;
      }
    }
  }
  return n;
}

/**
 * Offline validate/generate gate interpretation.
 * Both must exit 0. Non-zero is a blocker (schema invalid or client drift).
 */
export function interpretPrismaValidateGenerate(args: {
  validateExitCode: number;
  generateExitCode: number;
}): MigrationGuardResult {
  const findings: MigrationGuardFinding[] = [];
  if (args.validateExitCode !== 0) {
    findings.push({
      code: 'prisma_validate_failed',
      severity: 'blocker',
      message: `prisma validate exited ${args.validateExitCode}`,
    });
  }
  if (args.generateExitCode !== 0) {
    findings.push({
      code: 'prisma_generate_failed',
      severity: 'blocker',
      message: `prisma generate exited ${args.generateExitCode}`,
    });
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Clean migrate replay / upgrade replay interpretation.
 * - cleanReplayExitCode: empty DB `migrate deploy` must be 0
 * - upgradeReplayExitCode: base schema → tip schema deploy must be 0
 * - must not have touched history via resolve
 */
export function interpretMigrateReplay(args: {
  cleanReplayExitCode: number;
  upgradeReplayExitCode?: number | null;
  usedMigrateResolve?: boolean;
  mutatedPrismaMigrationsTable?: boolean;
}): MigrationGuardResult {
  const findings: MigrationGuardFinding[] = [];
  if (args.cleanReplayExitCode !== 0) {
    findings.push({
      code: 'clean_migrate_replay_failed',
      severity: 'blocker',
      message: `clean migrate replay exited ${args.cleanReplayExitCode}`,
    });
  }
  if (
    args.upgradeReplayExitCode !== null &&
    args.upgradeReplayExitCode !== undefined &&
    args.upgradeReplayExitCode !== 0
  ) {
    findings.push({
      code: 'upgrade_migrate_replay_failed',
      severity: 'blocker',
      message: `upgrade migrate replay exited ${args.upgradeReplayExitCode}`,
    });
  }
  if (args.usedMigrateResolve) {
    findings.push({
      code: 'migrate_resolve_used_during_replay',
      severity: 'blocker',
      message: 'migrate resolve must not be used during permanent gate replay',
    });
  }
  if (args.mutatedPrismaMigrationsTable) {
    findings.push({
      code: 'prisma_migrations_table_hand_mutated',
      severity: 'blocker',
      message: 'direct _prisma_migrations mutation is forbidden',
    });
  }
  return { ok: findings.length === 0, findings };
}
