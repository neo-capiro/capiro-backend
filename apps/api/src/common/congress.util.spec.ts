import { describe, expect, test } from '@jest/globals';
import { currentCongressNumber } from './congress.util.js';

describe('currentCongressNumber', () => {
  test('Aug 20, 2026 resolves to the 119th Congress', () => {
    expect(currentCongressNumber(new Date(Date.UTC(2026, 7, 20)))).toBe(119);
  });

  test('any day inside the 119th term (not just the anchor date) resolves to 119', () => {
    expect(currentCongressNumber(new Date(Date.UTC(2025, 5, 15)))).toBe(119);
    expect(currentCongressNumber(new Date(Date.UTC(2026, 0, 1)))).toBe(119);
  });

  test('January 3 of an odd year — the term begins exactly here', () => {
    expect(currentCongressNumber(new Date(Date.UTC(2025, 0, 3)))).toBe(119);
    expect(currentCongressNumber(new Date(Date.UTC(2027, 0, 3)))).toBe(120);
  });

  test('January 1-2 of an odd year — the PRIOR Congress is still in session', () => {
    expect(currentCongressNumber(new Date(Date.UTC(2025, 0, 1)))).toBe(118);
    expect(currentCongressNumber(new Date(Date.UTC(2025, 0, 2)))).toBe(118);
    expect(currentCongressNumber(new Date(Date.UTC(2027, 0, 2)))).toBe(119);
  });

  test('the 120th Congress is not current until it is actually seated', () => {
    expect(currentCongressNumber(new Date(Date.UTC(2026, 11, 31)))).toBe(119);
    expect(currentCongressNumber(new Date(Date.UTC(2027, 0, 3)))).toBe(120);
  });
});
