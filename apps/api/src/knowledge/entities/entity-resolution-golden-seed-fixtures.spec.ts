import { describe, expect, test } from '@jest/globals';
import { JANE_SMITH_GOLDEN_FIXTURES } from './entity-resolution-golden-seed-fixtures.js';

describe('Jane Smith golden seed fixtures', () => {
  test('creates two distinct people sharing one exact alias', () => {
    expect(JANE_SMITH_GOLDEN_FIXTURES).toHaveLength(2);
    expect(new Set(JANE_SMITH_GOLDEN_FIXTURES.map((fixture) => fixture.id)).size).toBe(2);
    expect(
      JANE_SMITH_GOLDEN_FIXTURES.every((fixture) =>
        fixture.aliases.includes('Jane Smith'),
      ),
    ).toBe(true);
  });

  test('assigns the exact email only to the intended Example Defense person', () => {
    const owners = JANE_SMITH_GOLDEN_FIXTURES.filter((fixture) =>
      fixture.identifiers.some(
        (identifier) =>
          identifier.type === 'email' &&
          identifier.value === 'jane.smith@example.com',
      ),
    );

    expect(owners).toHaveLength(1);
    expect(owners[0]?.canonicalName).toBe('Jane Smith — Example Defense');
  });
});
