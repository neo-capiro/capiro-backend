import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { CANONICAL_PUBLIC_REFERENCE_SOURCES } from './canonical-public-reference-backfill.types.js';

function repositoryPath(relativePath: string): string {
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), 'apps/api', relativePath),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

describe('canonical public reference backfill contract', () => {
  test('covers the first authoritative Phase 5 public identity sources', () => {
    expect(CANONICAL_PUBLIC_REFERENCE_SOURCES).toEqual([
      'federal_contractors',
      'congress_members',
      'congress_committees',
      'acquisition_personnel',
      'program_elements',
      'lda_clients',
      'sec_companies',
    ]);
  });

  test('uses exact source identifiers and contains no fuzzy/model/embedding path', () => {
    const source = readFileSync(
      repositoryPath(
        'src/knowledge/entities/canonical-public-reference-backfill.repository.ts',
      ),
      'utf8',
    );

    for (const identifier of [
      'uei',
      'usaspending_recipient_id',
      'congress_id',
      'committee_id',
      'directory_person_id',
      'program_element_code',
      'lda_client_id',
      'cik',
    ]) {
      expect(source).toContain(`'${identifier}'`);
    }

    expect(source).not.toMatch(/similarity\s*\(/i);
    expect(source).not.toMatch(/pg_trgm|embedding|rerank|model[_-]?assisted/i);
    expect(source).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  });

  test('dry-run is the default and writes go through one registration boundary', () => {
    const service = readFileSync(
      repositoryPath(
        'src/knowledge/entities/canonical-public-reference-backfill.service.ts',
      ),
      'utf8',
    );
    const script = readFileSync(
      repositoryPath('scripts/backfill-canonical-public-references.ts'),
      'utf8',
    );

    expect(service).toContain('const execute = input.execute === true');
    expect(service).toContain('registerGlobalPublicEntity');
    expect(service).not.toMatch(/canonical_entities|entity_identifiers|entity_aliases/i);
    expect(script).toContain("execute: { type: 'boolean', default: false }");
    expect(script).toContain('--source is required');
  });

  test('keyset pagination stops on failure without skipping the failed row', () => {
    const service = readFileSync(
      repositoryPath(
        'src/knowledge/entities/canonical-public-reference-backfill.service.ts',
      ),
      'utf8',
    );
    const repository = readFileSync(
      repositoryPath(
        'src/knowledge/entities/canonical-public-reference-backfill.repository.ts',
      ),
      'utf8',
    );

    expect(repository).toContain('cursor_key');
    expect(repository).toContain('ORDER BY');
    expect(service).toContain('Stop on the first failure');
    expect(service).toContain('result.nextCursor = row.cursorKey');
  });
});
