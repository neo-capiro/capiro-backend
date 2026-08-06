import { describe, expect, test } from '@jest/globals';
import { extractJsonObject } from './json-extract.js';

describe('extractJsonObject', () => {
  test('passes through bare JSON unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  test('strips a ```json fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('strips a bare ``` fence with no language tag', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('narrows to the object when the model adds a leading sentence', () => {
    expect(extractJsonObject('Sure, here is the plan:\n{"a":1}')).toBe('{"a":1}');
  });

  test('narrows to the object when the model adds a trailing sentence', () => {
    expect(extractJsonObject('{"a":1}\nLet me know if you need changes.')).toBe('{"a":1}');
  });

  test('returns null for text with no braces', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  test('returns null for an empty string', () => {
    expect(extractJsonObject('   ')).toBeNull();
  });
});
