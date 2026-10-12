import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNoMigrationHistoryMutation,
  countMigrateDeployInvocations,
  interpretMigrateReplay,
  interpretPrismaValidateGenerate,
  inspectApprovedManualMigrationEntrypoints,
  stripShellComments,
  type EntrypointSourceSnapshot,
} from './pe-migration-guards.js';

describe('pe-migration-guards (K4)', () => {
  test('stripShellComments drops # lines only', () => {
    const src = '# comment\nprisma migrate deploy\n  # other\necho hi\n';
    expect(stripShellComments(src)).toBe('prisma migrate deploy\necho hi\n');
  });

  test('blocks _prisma_migrations and migrate resolve in entrypoint body', () => {
    const bad = assertNoMigrationHistoryMutation([
      {
        path: 'entrypoint.sh',
        source: 'UPDATE _prisma_migrations SET rolled_back_at = NOW() WHERE id=1\n',
      },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((f) => f.code).sort()).toEqual([
      'auto_rolled_back_at',
      'hand_edit_prisma_migrations_table',
    ]);

    const resolve = assertNoMigrationHistoryMutation([
      { path: 'x.sh', source: 'npx prisma migrate resolve --rolled-back foo\n' },
    ]);
    expect(resolve.ok).toBe(false);
    expect(resolve.findings.some((f) => f.code === 'prisma_migrate_resolve')).toBe(true);
  });

  test('allows migrate deploy and ignores commented history references', () => {
      const ok = assertNoMigrationHistoryMutation([
        {
          path: 'entrypoint.sh',
          source: [
            '# Never touch _prisma_migrations by hand',
            'node ./node_modules/prisma/build/index.js migrate deploy',
            '',
          ].join('\n'),
        },
      ]);
      expect(ok.ok).toBe(true);
      expect(
        countMigrateDeployInvocations([
          {
            path: 'entrypoint.sh',
            source:
              'echo "Running prisma migrate deploy (failed migration history is never auto-resolved)"\n' +
              'node ./node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma\n' +
              '# migrate deploy again\n',
          },
        ]),
      ).toBe(1);
    });

  test('validate/generate exit codes', () => {
    expect(interpretPrismaValidateGenerate({ validateExitCode: 0, generateExitCode: 0 }).ok).toBe(
      true,
    );
    const bad = interpretPrismaValidateGenerate({ validateExitCode: 1, generateExitCode: 0 });
    expect(bad.ok).toBe(false);
    expect(bad.findings[0]?.code).toBe('prisma_validate_failed');
  });

  test('replay interpretation forbids resolve and history mutation', () => {
    expect(
      interpretMigrateReplay({ cleanReplayExitCode: 0, upgradeReplayExitCode: 0 }).ok,
    ).toBe(true);
    const bad = interpretMigrateReplay({
      cleanReplayExitCode: 0,
      usedMigrateResolve: true,
      mutatedPrismaMigrationsTable: true,
    });
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((f) => f.code).sort()).toEqual([
      'migrate_resolve_used_during_replay',
      'prisma_migrations_table_hand_mutated',
    ]);
  });
});

function approvedSnapshots(): EntrypointSourceSnapshot[] {
  const cwd = process.cwd();
  const root = cwd.replace(/\\/g, '/').endsWith('/apps/api') ? cwd : resolve(cwd, 'apps/api');
  return ['scripts/entrypoint.sh', 'scripts/entrypoint-legacy.sh', 'scripts/entrypoint-dispatcher.inc']
    .map((path) => ({ path, source: readFileSync(resolve(root, path), 'utf8') }));
}

function changedSource(path: string, edit: (source: string) => string): EntrypointSourceSnapshot[] {
  const snapshots = approvedSnapshots();
  const snapshot = snapshots.find((s) => s.path === path)!;
  const next = edit(snapshot.source);
  expect(next).not.toBe(snapshot.source); // Every hostile fixture must actually mutate source.
  snapshot.source = next;
  return snapshots;
}

describe('approved manual migration source protocol', () => {
  test('attests the exact raw trio and two explicit arms without executing them', () => {
    const snapshots = approvedSnapshots();
    expect(inspectApprovedManualMigrationEntrypoints(snapshots)).toEqual({ ok: true, findings: [] });
    expect(assertNoMigrationHistoryMutation(snapshots)).toEqual({ ok: true, findings: [] });
    expect(countMigrateDeployInvocations(snapshots)).toBe(1);
  });

  test('CRLF normalization and snapshot ordering preserve the same protocol', () => {
    const snapshots = approvedSnapshots().reverse().map((s) => ({
      ...s, source: s.source.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'),
    }));
    expect(assertNoMigrationHistoryMutation(snapshots)).toEqual({ ok: true, findings: [] });
  });

  const envelopeEdits: Array<[string, (s: EntrypointSourceSnapshot[]) => EntrypointSourceSnapshot[]]> = [
    ['missing active', (s: EntrypointSourceSnapshot[]) => s.slice(1)],
    ['missing legacy', (s: EntrypointSourceSnapshot[]) => s.filter((x) => x.path !== 'scripts/entrypoint-legacy.sh')],
    ['missing dispatcher', (s: EntrypointSourceSnapshot[]) => s.slice(0, 2)],
    ['duplicate active', (s: EntrypointSourceSnapshot[]) => [s[0]!, s[0]!, s[2]!]],
    ['duplicate extra active', (s: EntrypointSourceSnapshot[]) => [...s, s[0]!]],
    ['extra clean source', (s: EntrypointSourceSnapshot[]) => [...s, { path: 'extra.sh', source: 'echo safe\n' }]],
    ['relative alias path', (s: EntrypointSourceSnapshot[]) => s.map((x) => ({ ...x, path: './' + x.path }))],
    ['absolute alias path', (s: EntrypointSourceSnapshot[]) => s.map((x) => ({ ...x, path: '/app/apps/api/' + x.path }))],
    ['case alias path', (s: EntrypointSourceSnapshot[]) => s.map((x) => ({ ...x, path: x.path.toUpperCase() }))],
    ['pre-stripped raw source', (s: EntrypointSourceSnapshot[]) => s.map((x) => ({ ...x, source: stripShellComments(x.source) }))],
  ];
  test.each(envelopeEdits)('refuses incomplete or spoofed envelope: %s', (_name, edit) => {
    const snapshots = edit(approvedSnapshots());
    expect(inspectApprovedManualMigrationEntrypoints(snapshots).ok).toBe(false);
    expect(assertNoMigrationHistoryMutation(snapshots).ok).toBe(false);
  });

  const activePath = 'scripts/entrypoint.sh';
  const edits: ReadonlyArray<readonly [string, string, (source: string) => string]> = [
    ['comment-only drift', activePath, (s) => s.replace('# Program Elements', '# Changed Program Elements')],
    ['UTF8 BOM', activePath, (s) => '\uFEFF' + s],
    ['Unicode whitespace', activePath, (s) => s.replace('    shift', '    \u00a0shift')],
    ['extra newline', activePath, (s) => s + '\n'],
    ['selector default recovery', activePath, (s) => s.replace('case "${1:-serve}" in', 'case "${1:-migrate-resolve-applied}" in')],
    ['selector variable rebound', activePath, (s) => s.replace('case "${1:-serve}" in', 'set -- migrate-resolve-applied old\ncase "${1:-serve}" in')],
    ['pre-case resolve', activePath, (s) => s.replace('select_writable_tmpdir\n\ncase', 'select_writable_tmpdir\nnode ./node_modules/prisma/build/index.js migrate resolve --applied old\n\ncase')],
    ['set-e removed', activePath, (s) => s.replace('set -e', 'set +e')],
    ['nested operator case', activePath, (s) => s.replace('  migrate-resolve-applied)', '  wrapper)\n    case "$1" in\n  migrate-resolve-applied)')],
    ['duplicate operator arm', activePath, (s) => s.replace('  migrate-resolve-applied)', '  migrate-resolve-applied)\n    ;;\n  migrate-resolve-applied)')],
    ['operator wildcard arm', activePath, (s) => s.replace('  migrate-resolve-applied)', '  migrate-resolve-*)')],
    ['operator mode union arm', activePath, (s) => s.replace('  migrate-resolve-applied)', '  serve|migrate-resolve-applied)')],
    ['missing rolled-back shift', activePath, (s) => s.replace('  migrate-resolve-rolled-back)\n    shift', '  migrate-resolve-rolled-back)')],
    ['empty-name check removed', activePath, (s) => s.replace('if [ -z "${1:-}" ]; then', 'if false; then')],
    ['empty-name successful exit', activePath, (s) => s.replace('      exit 1\n    fi\n    compose_database_url', '      exit 0\n    fi\n    compose_database_url')],
    ['URL composition before name guard', activePath, (s) => s.replace('  migrate-resolve-applied)\n    shift', '  migrate-resolve-applied)\n    compose_database_url\n    shift')],
    ['URL composition missing', activePath, (s) => s.replace('    compose_database_url\n    # Same controlled-recovery', '    # Same controlled-recovery')],
    ['resolve logger spoofed', activePath, (s) => s.replace('echo "Running prisma migrate resolve --applied $1', 'echo "Pretend prisma migrate resolve --applied $1')],
    ['resolve executed before guard', activePath, (s) => s.replace('  migrate-resolve-applied)\n    shift', '  migrate-resolve-applied)\n    exec node ./node_modules/prisma/build/index.js migrate resolve --applied "$2"\n    shift')],
    ['Prisma exec removed', activePath, (s) => s.replace('exec node ./node_modules/prisma/build/index.js migrate resolve --schema', 'node ./node_modules/prisma/build/index.js migrate resolve --schema')],
    ['Prisma schema changed', activePath, (s) => s.replace('migrate resolve --schema=./prisma/schema.prisma', 'migrate resolve --schema=./other.prisma')],
    ['Prisma mode changed', activePath, (s) => s.replace('--schema=./prisma/schema.prisma --applied "$1"', '--schema=./prisma/schema.prisma --rolled-back "$1"')],
    ['all argv forwarded', activePath, (s) => s.replace('--applied "$1"', '--applied "$@"')],
    ['migration-name unquoted', activePath, (s) => s.replace('--applied "$1"', '--applied $1')],
    ['extra Prisma argv', activePath, (s) => s.replace('--applied "$1"', '--applied "$1" --force')],
    ['extra inline command', activePath, (s) => s.replace('--applied "$1"', '--applied "$1"; echo injected')],
    ['command substitution name', activePath, (s) => s.replace('--applied "$1"', '--applied "$(echo "$1")"')],
    ['eval obfuscated resolve', activePath, (s) => s.replace('  migrate)\n', '  migrate)\n    eval "node ./node_modules/prisma/build/index.js migrate re""solve --applied old"\n')],
    ['continued obfuscated resolve', activePath, (s) => s.replace('  migrate)\n', '  migrate)\n    node ./node_modules/prisma/build/index.js migrate \\\n      resolve --applied old\n')],
    ['automatic failure fallback', activePath, (s) => s.replace('migrate deploy --schema=./prisma/schema.prisma', 'migrate deploy --schema=./prisma/schema.prisma || node ./node_modules/prisma/build/index.js migrate resolve --applied old')],
    ['automatic retry loop', activePath, (s) => s.replace('  migrate)\n', '  migrate)\n    while true; do node ./node_modules/prisma/build/index.js migrate resolve --applied old; done\n')],
    ['compose helper rebound', activePath, (s) => s.replace('select_writable_tmpdir\n\ncase', 'compose_database_url() { node ./node_modules/prisma/build/index.js migrate resolve --applied old; }\nselect_writable_tmpdir\n\ncase')],
    ['node shell function rebound', activePath, (s) => s.replace('select_writable_tmpdir\n\ncase', 'node() { echo spoof; }\nselect_writable_tmpdir\n\ncase')],
    ['operator fallthrough', activePath, (s) => s.replace('--applied "$1"\n    ;;', '--applied "$1"\n    ;&')],
    ['operator continues case matching', activePath, (s) => s.replace('--applied "$1"\n    ;;', '--applied "$1"\n    ;;&')],
    ['default executes recovery', activePath, (s) => s.replace('exec /bin/sh /usr/local/lib/capiro/entrypoint-legacy.sh "$@"', 'exec node ./node_modules/prisma/build/index.js migrate resolve --applied "$1"')],
    ['direct history write in approved arm', activePath, (s) => s.replace('  migrate-resolve-applied)\n', '  migrate-resolve-applied)\n    echo "UPDATE _prisma_migrations SET finished_at=NOW()"\n')],
    ['rollback timestamp in approved arm', activePath, (s) => s.replace('  migrate-resolve-applied)\n', '  migrate-resolve-applied)\n    echo "rolled_back_at = NOW()"\n')],
    ['legacy migration refusal changed', 'scripts/entrypoint-legacy.sh', (s) => s.replace('exit 64', 'exit 0')],
    ['legacy resolves on serve', 'scripts/entrypoint-legacy.sh', (s) => s + 'node ./node_modules/prisma/build/index.js migrate resolve --applied old\n'],
    ['dispatcher refusal changed', 'scripts/entrypoint-dispatcher.inc', (s) => s.replace('    exit 64', '    exit 0')],
    ['comment-prefix hidden in quoted awk', 'scripts/entrypoint-dispatcher.inc', (s) => s.replace("awk -v str=\"$1\" 'BEGIN {", "awk -v str=\"$1\" 'BEGIN {\n#' ; node ./node_modules/prisma/build/index.js migrate resolve --applied old #")],
    ['dispatcher resolves on serve', 'scripts/entrypoint-dispatcher.inc', (s) => s.replace('case "${1:-serve}" in', 'node ./node_modules/prisma/build/index.js migrate resolve --applied old\ncase "${1:-serve}" in')],
  ];
  test.each(edits)('refuses unreviewed source/control-flow mutation: %s', (_name, path, edit) => {
    const snapshots = changedSource(path, edit);
    const result = assertNoMigrationHistoryMutation(snapshots);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'manual_migration_source_protocol_unproven')).toBe(true);
    expect(assertNoMigrationHistoryMutation(snapshots)).toEqual(result);
    expect(assertNoMigrationHistoryMutation(approvedSnapshots())).toEqual({ ok: true, findings: [] });
  });

  test('all direct history and rollback patterns still apply within an operator-looking arm', () => {
    const snapshots = changedSource(activePath, (s) => s.replace(
      '  migrate-resolve-applied)\n',
      '  migrate-resolve-applied)\n    echo "UPDATE _prisma_migrations SET rolled_back_at = NOW()"\n',
    ));
    const codes = assertNoMigrationHistoryMutation(snapshots).findings.map((f) => f.code);
    expect(codes).toContain('hand_edit_prisma_migrations_table');
    expect(codes).toContain('auto_rolled_back_at');
    expect(codes).toContain('prisma_migrate_resolve');
  });

  test('manual-source attestation never permits resolve during gate replay', () => {
    expect(assertNoMigrationHistoryMutation(approvedSnapshots()).ok).toBe(true);
    expect(interpretMigrateReplay({ cleanReplayExitCode: 0, upgradeReplayExitCode: 0, usedMigrateResolve: true }))
      .toEqual({ ok: false, findings: [{ code: 'migrate_resolve_used_during_replay', severity: 'blocker',
        message: 'migrate resolve must not be used during permanent gate replay' }] });
  });

  test.each(['inspector', 'guard'] as const)('captures snapshot primitive fields exactly once: %s', (mode) => {
    const originals = approvedSnapshots();
    const reads = originals.map(() => ({ path: 0, source: 0 }));
    const snapshots = originals.map((original, index) => ({
      get path(): string {
        reads[index]!.path += 1;
        return reads[index]!.path === 1 ? original.path : 'spoofed.sh';
      },
      get source(): string {
        reads[index]!.source += 1;
        return reads[index]!.source === 1 ? original.source : 'UPDATE _prisma_migrations SET rolled_back_at = NOW()';
      },
    }));
    const result = mode === 'inspector'
      ? inspectApprovedManualMigrationEntrypoints(snapshots)
      : assertNoMigrationHistoryMutation(snapshots);
    expect(result).toEqual({ ok: true, findings: [] });
    expect(reads).toEqual([{ path: 1, source: 1 }, { path: 1, source: 1 }, { path: 1, source: 1 }]);
    // A later call observes the changed input and refuses; no cached acceptance.
    expect(assertNoMigrationHistoryMutation(snapshots).ok).toBe(false);
  });
});
