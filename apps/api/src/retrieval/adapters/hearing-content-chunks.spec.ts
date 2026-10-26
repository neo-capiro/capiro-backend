import { encodeHearingContentCursor, parseHearingContentCursor } from './hearing-content-chunks.js';

const ordinary = ['event', 'official', 'segment', 'insight', 'relevance'];
const published = ['published', 'briefs', 'reconciliation'];
const cursor = (key: string) => ({ key, hash: 'a'.repeat(64), part: 1 });

describe('hearing cursor reader families', () => {
  it('preserves the ordinary default and excludes those keys from published reads', () => {
    for (const prefix of ordinary) {
      const input = cursor(`${prefix}:synthetic-record`);
      const encoded = encodeHearingContentCursor(input);
      expect(parseHearingContentCursor(encoded)).toEqual(input);
      expect(() => parseHearingContentCursor(encoded, 'published-record')).toThrow(
        'invalid_cursor',
      );
    }
  });

  it('round-trips exact published families only when that reader is selected', () => {
    for (const prefix of published) {
      const input = cursor(`${prefix}:synthetic-record`);
      const encoded = encodeHearingContentCursor(input);
      expect(parseHearingContentCursor(encoded, 'published-record')).toEqual(input);
      expect(() => parseHearingContentCursor(encoded)).toThrow('invalid_cursor');
    }
  });

  it('keeps malformed, unknown-family and part/hash bounds closed in both readers', () => {
    for (const family of ['ordinary', 'published-record'] as const) {
      const input = cursor(`${family === 'ordinary' ? 'event' : 'published'}:synthetic-record`);
      for (const invalid of [
        { ...input, key: 'unknown:synthetic-record' },
        { ...input, key: input.key + 'x'.repeat(301) },
        { ...input, part: 0 },
        { ...input, part: -1 },
        { ...input, part: 1.5 },
        { ...input, part: Number.MAX_SAFE_INTEGER + 1 },
        { ...input, hash: 'a'.repeat(63) },
      ]) {
        expect(() =>
          parseHearingContentCursor(encodeHearingContentCursor(invalid), family),
        ).toThrow('invalid_cursor');
      }
      expect(() => parseHearingContentCursor('hearing:not-json', family)).toThrow('invalid_cursor');
      expect(parseHearingContentCursor('event:ordinary-scan-position', family)).toBeNull();
    }
  });
});
