import { describe, expect, test } from '@jest/globals';
import {
  assertNoMigrationHistoryMutation,
  countMigrateDeployInvocations,
  interpretMigrateReplay,
  interpretPrismaValidateGenerate,
  stripShellComments,
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
