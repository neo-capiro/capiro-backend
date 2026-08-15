import { describe, expect, test } from '@jest/globals';
import { ENTITY_RESOLUTION_GOLDEN_CORPUS } from './entity-resolution-golden-corpus.js';

describe('Phase 5 entity-resolution golden corpus', () => {
  test('covers exact identity, ambiguity, people, corporate structure, and privacy', () => {
    const categories = new Set(
      ENTITY_RESOLUTION_GOLDEN_CORPUS.map((testCase) => testCase.category),
    );
    for (const category of [
      'exact_identifier',
      'alias',
      'ambiguity',
      'corporate_structure',
      'person_identity',
      'privacy',
      'generic_mailbox',
      'rename',
    ]) {
      expect(categories).toContain(category);
    }
  });

  test('contains no duplicate IDs and every resolved case names the expected entity', () => {
    const ids = ENTITY_RESOLUTION_GOLDEN_CORPUS.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of ENTITY_RESOLUTION_GOLDEN_CORPUS) {
      if (testCase.expected.status === 'resolved') {
        expect(testCase.expected.selectedCanonicalName?.trim()).toBeTruthy();
      }
    }
  });

  test('includes explicit cross-tenant non-disclosure cases', () => {
    const privacyCases = ENTITY_RESOLUTION_GOLDEN_CORPUS.filter(
      (testCase) => testCase.category === 'privacy',
    );
    expect(privacyCases.length).toBeGreaterThanOrEqual(2);
    expect(
      privacyCases.every(
        (testCase) =>
          testCase.expected.status === 'unresolved' &&
          (testCase.expected.forbiddenCanonicalNames?.length ?? 0) > 0,
      ),
    ).toBe(true);
  });
});
