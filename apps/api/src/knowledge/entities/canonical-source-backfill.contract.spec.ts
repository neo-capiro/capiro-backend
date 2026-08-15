import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function repositoryPath(relativePath: string): string {
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), 'apps/api', relativePath),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

const repository = readFileSync(
  repositoryPath('src/knowledge/entities/canonical-source-backfill.repository.ts'),
  'utf8',
);
const script = readFileSync(
  repositoryPath('scripts/backfill-canonical-entities.ts'),
  'utf8',
);

describe('canonical source backfill contract', () => {
  test('uses tenant-bound keyset pagination rather than offset pagination', () => {
    expect(repository).toContain('WHERE tenant_id = ${tenantId}::uuid');
    expect(repository).toContain('id > ${afterId}::uuid');
    expect(repository).toContain('ORDER BY id');
    expect(repository).not.toMatch(/\bOFFSET\b/i);
  });

  test('promotes only confirmed reviewed mappings from supported public sources', () => {
    expect(repository).toContain("mapping.source IN ('contracting', 'lda')");
    expect(repository).toContain('mapping.confirmed = true');
    expect(repository).toContain("mapping.review_status = 'confirmed'");
    expect(repository).toContain('federal_contractor_id');
    expect(repository).toContain('lda_client_id');
    expect(repository).not.toMatch(/\bsimilarity\s*\(/i);
  });

  test('requires an explicit tenant/source and documents the safe source order', () => {
    expect(script).toContain("if (!tenantId) throw new Error('--tenant is required')");
    expect(script).toContain("'confirmed_client_mapping'");
    expect(script).toContain("'client_person'");
    expect(script).toContain('--dry-run uses resolver.preview');
    expect(script).toContain('Process confirmed public-source mappings first');
  });

  test('runs one bounded page and returns a resume cursor', () => {
    expect(script).toContain('backfill.runPage');
    expect(script).toContain('afterId: values.after');
    expect(script).toContain("event: 'canonical_entity_backfill.page'");
  });
});
