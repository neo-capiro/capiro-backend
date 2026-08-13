import { describe, expect, it } from '@jest/globals';
import { normalizeHandle } from './x-feed.service.js';

describe('normalizeHandle', () => {
  it('accepts a plain username', () => {
    expect(normalizeHandle('DeptofDefense')).toBe('DeptofDefense');
  });

  it('strips a leading @', () => {
    expect(normalizeHandle('@DeptofDefense')).toBe('DeptofDefense');
  });

  it('strips multiple leading @', () => {
    expect(normalizeHandle('@@@DeptofDefense')).toBe('DeptofDefense');
  });

  it('extracts from an x.com URL', () => {
    expect(normalizeHandle('https://x.com/DeptofDefense')).toBe('DeptofDefense');
  });

  it('extracts from a twitter.com URL', () => {
    expect(normalizeHandle('https://twitter.com/DeptofDefense')).toBe('DeptofDefense');
  });

  it('extracts from an x.com URL with path suffix', () => {
    expect(normalizeHandle('https://x.com/DeptofDefense/status/123')).toBe('DeptofDefense');
  });

  it('extracts from www prefix', () => {
    expect(normalizeHandle('https://www.x.com/HASCDemocrats')).toBe('HASCDemocrats');
  });

  it('trims whitespace', () => {
    expect(normalizeHandle('  DeptofDefense  ')).toBe('DeptofDefense');
  });

  it('rejects empty input', () => {
    expect(normalizeHandle('')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(normalizeHandle('   ')).toBeNull();
  });

  it('rejects handles longer than 15 characters', () => {
    expect(normalizeHandle('ThisHandleIsTooLong123')).toBeNull();
  });

  it('rejects handles with special characters', () => {
    expect(normalizeHandle('handle!')).toBeNull();
    expect(normalizeHandle('handle.space')).toBeNull();
    expect(normalizeHandle('handle-dash')).toBeNull();
  });

  it('accepts underscores', () => {
    expect(normalizeHandle('HASCDemocrats')).toBe('HASCDemocrats');
    expect(normalizeHandle('_underscore')).toBe('_underscore');
  });

  it('accepts the minimum 1-character handle', () => {
    expect(normalizeHandle('a')).toBe('a');
  });

  it('rejects arbitrary URLs', () => {
    expect(normalizeHandle('https://evil.com/DeptofDefense')).toBeNull();
    expect(normalizeHandle('https://api.x.com/2/users')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(normalizeHandle(null as unknown as string)).toBeNull();
    expect(normalizeHandle(undefined as unknown as string)).toBeNull();
  });
});
