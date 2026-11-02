import { describe, expect, it } from '@jest/globals';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  ownerReadBinding,
  ownerReadLimit,
  exactRevision,
} from './memory-owner-history.cursor.js';
const seek = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: '2026-10-31T12:00:00.123456Z',
  createdAt: '2026-10-30T12:00:00.000001Z',
};
describe('owner history cursors', () => {
  it('preserves microseconds and binds identity, endpoint and preview scope', () => {
    const binding = ownerReadBinding(['versions', 'tenant', 'owner', 'item', ['client']]);
    const cursor = encodeHistoryCursor(seek, binding);
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(decodeHistoryCursor(cursor, binding)).toEqual(seek);
    for (const parts of [
      ['evidence', 'tenant', 'owner', 'item', ['client']],
      ['versions', 'other', 'owner', 'item', ['client']],
      ['versions', 'tenant', 'other', 'item', ['client']],
      ['versions', 'tenant', 'owner', 'other', ['client']],
      ['versions', 'tenant', 'owner', 'item', []],
    ]) {
      expect(() => decodeHistoryCursor(cursor, ownerReadBinding(parts))).toThrow();
    }
  });
  it('rejects extra fields, wrong namespaces, invalid dates and oversized cursors', () => {
    for (const value of [
      { v: 1, binding: 'b', ...seek, extra: true },
      { v: 1, binding: 'b', ...seek, id: 'clio:' + seek.id },
      { v: 1, binding: 'b', ...seek, createdAt: '2026-02-30T00:00:00.000000Z' },
    ]) {
      expect(() =>
        decodeHistoryCursor(Buffer.from(JSON.stringify(value)).toString('base64url'), 'b'),
      ).toThrow();
    }
    expect(() => decodeHistoryCursor('x'.repeat(513), 'b')).toThrow();
    expect(exactRevision('2026-10-31T12:00:00.123Z')).toBe(false);
  });
  it('accepts only bounded integer limits', () => {
    expect(ownerReadLimit(undefined)).toBe(25);
    expect(ownerReadLimit('100')).toBe(100);
    for (const raw of [null, '', 0, 101, '1e1', '01', [], 1.5])
      expect(() => ownerReadLimit(raw)).toThrow();
  });
});
