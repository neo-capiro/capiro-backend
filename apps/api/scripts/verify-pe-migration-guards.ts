/**
 * Executable migration guards for PE permanent release gate (K4).
 *
 * Offline (always):
 *  - entrypoints: no _prisma_migrations mutation, no migrate resolve
 *  - exactly one active migrate deploy path among entrypoint trio
 *  - package scripts expose prisma validate / generate
 *
 * Optional live flags (disposable Postgres only — never shared envs):
 *  - --validate-generate : run prisma validate + generate (needs dummy DATABASE_URL ok)
 *
 * Clean/upgrade replay against disposable Postgres is documented in the runbook
 * and gated by interpretMigrateReplay() unit tests; this CLI does not mutate
 * shared databases.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNoMigrationHistoryMutation,
  countMigrateDeployInvocations,
  interpretPrismaValidateGenerate,
  stripShellComments,
} from './lib/pe-migration-guards.js';

function apiRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  return cwd.endsWith('/apps/api') ? process.cwd() : resolve(process.cwd(), 'apps/api');
}

function read(rel: string): string {
  return readFileSync(resolve(apiRoot(), rel), 'utf8').replace(/\r\n/g, '\n');
}

function main(): void {
  const runValidateGenerate = process.argv.includes('--validate-generate');

  const snaps = [
    'scripts/entrypoint.sh',
    'scripts/entrypoint-legacy.sh',
    'scripts/entrypoint-dispatcher.inc',
  ].map((path) => ({ path, source: read(path) }));

  const history = assertNoMigrationHistoryMutation(snaps);
  assert.equal(
    history.ok,
    true,
    `migration history mutation forbidden:\n${history.findings.map((f) => f.message).join('\n')}`,
  );

  // Only the active entrypoint may execute migrate deploy (body, not comments)
  const deployCount = countMigrateDeployInvocations(
    snaps.map((s) => ({ path: s.path, source: stripShellComments(s.source) })),
  );
  assert.equal(
    deployCount,
    1,
    `expected exactly one migrate deploy path in entrypoints, found ${deployCount}`,
  );

  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  assert.match(scripts['prisma:generate'] ?? '', /prisma\s+generate/);
  // migrate deploy for deploy path only
  assert.match(scripts['prisma:migrate:deploy'] ?? '', /migrate\s+deploy/);
  assert.equal(
    /migrate\s+resolve/.test(JSON.stringify(scripts)),
    false,
    'package scripts must not expose migrate resolve',
  );

  if (runValidateGenerate) {
      const env = {
        ...process.env,
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://pe_gate:***@127.0.0.1:5432/pe_gate_offline?schema=public',
      };
      // Avoid pnpm/MSYS path doubling: invoke node + prisma build entry directly.
      const nodeBin =
        process.env.PE_PHASE_9_NODE ||
        process.env.NODE_EXE ||
        (existsSync('C:/Users/neoma/AppData/Local/hermes/node/node.exe')
          ? 'C:/Users/neoma/AppData/Local/hermes/node/node.exe'
          : 'node');
      const prismaCandidates = [
        resolve(apiRoot(), 'node_modules/prisma/build/index.js'),
        resolve(apiRoot(), '../../node_modules/prisma/build/index.js'),
      ];
      const prismaJs = prismaCandidates.find((p) => existsSync(p));
      if (!prismaJs) {
        throw new Error('prisma build entry not found for validate/generate');
      }
      let validateCode = 0;
      let generateCode = 0;
      try {
        execFileSync(nodeBin, [prismaJs, 'validate'], {
          cwd: apiRoot(),
          env,
          stdio: 'pipe',
        });
      } catch (e) {
        validateCode = (e as { status?: number }).status ?? 1;
      }
      try {
        execFileSync(nodeBin, [prismaJs, 'generate'], {
          cwd: apiRoot(),
          env,
          stdio: 'pipe',
        });
      } catch (e) {
        generateCode = (e as { status?: number }).status ?? 1;
      }
      const interpreted = interpretPrismaValidateGenerate({
        validateExitCode: validateCode,
        generateExitCode: generateCode,
      });
      assert.equal(
        interpreted.ok,
        true,
        interpreted.findings.map((f) => f.message).join('; '),
      );
      console.log('PE_MIGRATION_VALIDATE_GENERATE_OK');
    }

  console.log('PE_MIGRATION_GUARDS_OK');
}

main();
