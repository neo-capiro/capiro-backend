import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function apiFile(relativePath: string): string {
  const cwd = process.cwd();
  const apiRoot = cwd.replace(/\\/g, '/').endsWith('/apps/api')
    ? cwd
    : resolve(cwd, 'apps/api');
  return readFileSync(resolve(apiRoot, relativePath), 'utf8');
}

describe('Phase A operational safety guards', () => {
  test('supported entrypoint scripts contain no automatic Prisma migration-history mutation', () => {
    const active = apiFile('scripts/entrypoint.sh');
    const compatibility = apiFile('scripts/entrypoint-legacy.sh');
    // The dispatcher include is executed as `/bin/sh <path>` by the compatibility
    // shim, so it is a supported entrypoint too. Excluding it is how the
    // auto-resolve block survived the first Phase A pass.
    const dispatcher = apiFile('scripts/entrypoint-dispatcher.inc');

    for (const source of [active, compatibility, dispatcher]) {
      expect(source).not.toContain('_prisma_migrations');
      expect(source).not.toContain('rolled_back_at = NOW()');
      expect(source).not.toContain('Resolving failed migration:');
      expect(source).not.toMatch(/prisma[^\n]*migrate\s+resolve/);
    }

    expect(active).toMatch(/node .*prisma.* migrate deploy/);
    expect(compatibility).toContain('Refusing legacy migrate dispatch');
    expect(dispatcher).toContain('Refusing legacy migrate dispatch');
  });

  test('exactly one supported entrypoint can execute a migration', () => {
    // Compare executable lines only: a prose mention of the command in a header
    // comment is not a second execution path.
    const executable = (source: string): string =>
      source
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
    const sources = [
      apiFile('scripts/entrypoint.sh'),
      apiFile('scripts/entrypoint-legacy.sh'),
      apiFile('scripts/entrypoint-dispatcher.inc'),
    ].map(executable);

    expect(sources.filter((source) => /migrate deploy/.test(source))).toHaveLength(1);
  });

  test('the dispatcher usage output lists diag-pe-trust as a supported verb', () => {
    expect(apiFile('scripts/entrypoint-dispatcher.inc')).toMatch(
      /Unknown command[^\n]*diag-pe-trust/,
    );
  });

  test('generalized PDF ingestion has no canonical database writer import or connection', () => {
    const source = apiFile('scripts/ingest-defense-budget-pdf.ts');

    for (const forbidden of ['ProgramElementWriterService', 'PrismaClient', 'PrismaService']) {
      expect(source).not.toMatch(
        new RegExp(`(?:import\\s+[^;]*\\b${forbidden}\\b|new\\s+${forbidden}\\b)`),
      );
    }
    expect(source).not.toMatch(/from ['"][^'"]*prisma[^'"]*['"]/i);
    expect(source).toContain(
      'Canonical generalized defense-budget writes are disabled until the USD-millions migration in Phase b is verified.',
    );
    expect(source).toContain("if (posture === 'commit') throw new Error(COMMIT_DISABLED_MESSAGE)");
  });

  test('vendor parsing requires explicit authorization before credential environment loading', () => {
    const source = apiFile('scripts/ingest-defense-budget-pdf.ts');
    const loaderStart = source.indexOf('function loadVendorParseEnvironment');
    const beforeLoader = source.slice(0, loaderStart);

    expect(loaderStart).toBeGreaterThan(-1);
    expect(beforeLoader).not.toContain('dotenvConfig(');
    expect(source).toMatch(
      /function loadConfig\(\): RunConfig \{\s+loadVendorParseEnvironment\(\);/,
    );
    expect(source).toContain("const ALLOW_VENDOR_PARSE = '--allow-vendor-parse'");
    expect(source).toContain(
      '--extract-only requires explicit --allow-vendor-parse authorization before any archive or LlamaParse call.',
    );
  });
});
