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

const migration = readFileSync(
  repositoryPath(
    'prisma/migrations/20261120130000_canonical_entity_terminal_lifecycle/migration.sql',
  ),
  'utf8',
);
const rehearsal = readFileSync(
  repositoryPath('../../scripts/verify-entity-resolution-migration.sh'),
  'utf8',
);

describe('canonical identity terminal lifecycle contract', () => {
  test('freezes merged and withdrawn canonical entities', () => {
    expect(migration).toContain('reject_terminal_canonical_entity_mutation');
    expect(migration).toContain("OLD.status IN ('merged', 'withdrawn')");
    expect(migration).toContain(
      'Terminal CanonicalEntity rows are immutable',
    );
    expect(migration).toContain(
      'zz_canonical_entities_reject_terminal_mutation',
    );
  });

  test('prevents withdrawn aliases and identifiers from being reactivated', () => {
    expect(migration).toContain('reject_withdrawn_identity_link_mutation');
    expect(migration).toContain('entity_aliases_reject_withdrawn_mutation');
    expect(migration).toContain(
      'entity_identifiers_reject_withdrawn_mutation',
    );
  });

  test('rehearses unmerge and identity-link reactivation failures', () => {
    expect(rehearsal).toContain('terminal merged entity unexpectedly reopened');
    expect(rehearsal).toContain('withdrawn alias unexpectedly reactivated');
    expect(rehearsal).toContain(
      'withdrawn identifier unexpectedly reactivated',
    );
  });
});
