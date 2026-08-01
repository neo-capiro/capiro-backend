/**
 * PE / SOC2 migration guards (Phase K / closeout Phase 8) — pure checks.
 *
 * Permanent rules:
 *  1. Deploy path may run `prisma migrate deploy` only (never resolve / reset).
 *  2. No entrypoint / script may hand-edit `_prisma_migrations`.
 *  3. Validate + generate are required offline gates before replay evidence.
 *  4. Clean migrate replay and upgrade replay are operator steps; this module
 *     encodes how to interpret their results (exit codes / forbidden strings).
 */
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
  const findings: MigrationGuardFinding[] = [];
  for (const snap of snapshots) {
    const body = stripShellComments(snap.source);
    for (const rule of FORBIDDEN_MIGRATION_HISTORY_PATTERNS) {
      if (rule.re.test(body)) {
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
