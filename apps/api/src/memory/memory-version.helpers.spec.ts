import { describe, expect, test } from '@jest/globals';
import {
  classifyMemoryVersionActivation,
  immutableMemoryVersionSlug,
  normalizeMemoryVersionText,
} from './memory-version.helpers.js';

describe('immutable memory version decisions', () => {
  test('exact duplicate confirms the controlling row instead of creating another truth', () => {
    expect(classifyMemoryVersionActivation('correction', '  Ballard\nPartners  ', 'ballard partners')).toBe(
      'duplicate',
    );
    expect(classifyMemoryVersionActivation('restore', 'Same fact', 'same   fact')).toBe('duplicate');
  });

  test('a correction and restore become replacement versions when content differs', () => {
    expect(classifyMemoryVersionActivation('correction', 'new fact', 'old fact')).toBe('replace');
    expect(classifyMemoryVersionActivation('restore', 'historical truth', null)).toBe('replace');
  });

  test('an explicit contradiction retains both sides as a conflict', () => {
    expect(classifyMemoryVersionActivation('contradiction', 'no', 'yes')).toBe('conflict');
  });

  test('normalization is deterministic but never used as stored content', () => {
    expect(normalizeMemoryVersionText(' A\tB\nC ')).toBe('a b c');
  });

  test('every immutable version receives a stable distinct bounded slug', () => {
    const first = immutableMemoryVersionSlug(
      'client:overland~voldversion',
      '11111111-2222-3333-4444-555555555555',
    );
    const second = immutableMemoryVersionSlug(
      'client:overland',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(first).toBe('client:overland~v11111111222233334444555555555555');
    expect(second).toBe('client:overland~vaaaaaaaabbbbccccddddeeeeeeeeeeee');
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(200);
  });

  test('a maximum-length source slug keeps the complete immutable identity suffix', () => {
    const suffix = '~v11111111222233334444555555555555';
    const version = immutableMemoryVersionSlug(
      'x'.repeat(200),
      '11111111-2222-3333-4444-555555555555',
    );
    expect(version).toHaveLength(200);
    expect(version.endsWith(suffix)).toBe(true);
    expect(version).not.toBe('x'.repeat(200));
  });

  test('an empty candidate identity is rejected instead of producing a colliding slug', () => {
    expect(() => immutableMemoryVersionSlug('firm:positions', '---')).toThrow(
      'requires a stable candidate id',
    );
  });
});
