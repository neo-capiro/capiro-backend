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

const initialMigration = readFileSync(
  repositoryPath(
    'prisma/migrations/20261120100000_universal_entity_resolution/migration.sql',
  ),
  'utf8',
);
const hardeningMigration = readFileSync(
  repositoryPath(
    'prisma/migrations/20261120110000_universal_entity_resolution_hardening/migration.sql',
  ),
  'utf8',
);
const rehearsal = readFileSync(
  repositoryPath('../../scripts/verify-entity-resolution-migration.sh'),
  'utf8',
);

describe('Universal Entity Resolution hardening contract', () => {
  test('preserves one registry while making scope and type immutable', () => {
    expect(initialMigration).toContain('CREATE TABLE "canonical_entities"');
    expect(hardeningMigration).toContain('enforce_canonical_entity_invariants');
    expect(hardeningMigration).toContain('Canonical entity scope is immutable');
    expect(hardeningMigration).toContain('Canonical entity type is immutable');
    expect(hardeningMigration).toContain(
      'A tenant-private entity cannot merge into another tenant',
    );
    expect(hardeningMigration).toContain(
      'Canonical entities of different types cannot be merged',
    );
  });

  test('makes alias and identifier identity/provenance append-correctable', () => {
    expect(hardeningMigration).toContain(
      'EntityAlias identity and provenance are immutable',
    );
    expect(hardeningMigration).toContain(
      'EntityIdentifier identity and provenance are immutable',
    );
    expect(hardeningMigration).toContain(
      'entity_aliases_reject_identity_mutation',
    );
    expect(hardeningMigration).toContain(
      'entity_identifiers_reject_identity_mutation',
    );
  });

  test('fails closed on invisible or malformed resolution candidates', () => {
    expect(hardeningMigration).toContain(
      'Entity resolution candidate is not visible to this tenant',
    );
    expect(hardeningMigration).toContain(
      'Entity resolution candidates must not contain duplicates',
    );
    expect(hardeningMigration).toContain(
      'Selected canonical entity must be present in candidate_entity_ids',
    );
    expect(hardeningMigration).toContain(
      'An ambiguous resolution requires at least two visible candidates',
    );
  });

  test('requires attributable correction lineage without rewriting the query', () => {
    expect(hardeningMigration).toContain(
      'entity_resolutions_correction_state_check',
    );
    expect(hardeningMigration).toContain(
      'A correction must preserve the original resolution query',
    );
    expect(hardeningMigration).toContain('"actor_user_id" IS NOT NULL');
  });

  test('rehearses RLS, ambiguity, correction, merge, and immutability in PostgreSQL', () => {
    expect(rehearsal).toContain(
      'cross-tenant candidate unexpectedly committed',
    );
    expect(rehearsal).toContain(
      'selected entity outside candidate list unexpectedly committed',
    );
    expect(rehearsal).toContain(
      'correction query drift unexpectedly committed',
    );
    expect(rehearsal).toContain('alias provenance unexpectedly mutated');
    expect(rehearsal).toContain('cross-tenant merge unexpectedly committed');
    expect(rehearsal).toContain(
      'Knowledge Plane Phase 5 Universal Entity Resolution PostgreSQL rehearsal passed',
    );
  });
});
