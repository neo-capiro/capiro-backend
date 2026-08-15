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

const source = readFileSync(
  repositoryPath(
    'src/knowledge/entities/canonical-structured-public-lookup.repository.ts',
  ),
  'utf8',
);

describe('structured public entity lookup contract', () => {
  test('reads only authoritative source tables and never writes canonical identity', () => {
    for (const table of [
      'federal_contractor',
      'congress_member',
      'congress_committee',
      'acquisition_personnel',
      'program_element',
      'lda_client',
      'sec_filing',
    ]) {
      expect(source).toContain(table);
    }

    expect(source).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  });

  test('contains no fuzzy, vector, model, or retrieval-specific matching path', () => {
    expect(source).not.toMatch(/\bsimilarity\s*\(/i);
    expect(source).not.toMatch(/pg_trgm|embedding|vector|rerank|model[_-]?assisted/i);
  });
});
