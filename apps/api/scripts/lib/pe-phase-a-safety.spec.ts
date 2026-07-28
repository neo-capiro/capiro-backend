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

    for (const source of [active, compatibility]) {
      expect(source).not.toContain('_prisma_migrations');
      expect(source).not.toContain('rolled_back_at = NOW()');
      expect(source).not.toContain('Resolving failed migration:');
    }

    expect(active).toContain('prisma migrate deploy');
    expect(compatibility).toContain('Refusing legacy migrate dispatch');
  });

  test('generalized PDF ingestion has no canonical database writer import or connection', () => {
    const source = apiFile('scripts/ingest-defense-budget-pdf.ts');

    expect(source).not.toContain('ProgramElementWriterService');
    expect(source).not.toContain('PrismaClient');
    expect(source).not.toContain('PrismaService');
    expect(source).not.toMatch(/from ['"][^'"]*prisma[^'"]*['"]/i);
    expect(source).toContain(
      'Canonical generalized defense-budget writes are disabled until the USD-millions migration in Phase b is verified.',
    );
    expect(source).toContain("if (posture === 'commit') throw new Error(COMMIT_DISABLED_MESSAGE)");
  });

  test('vendor parsing requires an explicit operator authorization flag', () => {
    const source = apiFile('scripts/ingest-defense-budget-pdf.ts');

    expect(source).toContain("const ALLOW_VENDOR_PARSE = '--allow-vendor-parse'");
    expect(source).toContain(
      '--extract-only requires explicit --allow-vendor-parse authorization before any archive or LlamaParse call.',
    );
  });
});
