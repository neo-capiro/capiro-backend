import { eligibleFY26, inFY26 } from './bill-text-scope';
import { passages, encodeCursor, parseCursor, parseBillTextArgs } from './bill-text-passages';

describe('FY26 bill parent admission', () => {
  test.each([
    ['2025-09-30', false],
    ['2025-10-01', true],
    ['2026-09-30', true],
    ['2026-10-01', false],
    ['invalid', false],
  ])('%s => %s', (date, expected) => expect(inFY26(date as string)).toBe(expected));
  it('admits older introductions only with an in-window action', () => {
    expect(eligibleFY26('2025-01-03', ['2026-01-02'])).toBe(true);
    expect(eligibleFY26('2025-01-03', ['2026-10-02'])).toBe(false);
    expect(eligibleFY26(null, [])).toBe(false);
  });
});
describe('complete immutable text passages', () => {
  it('round-trips long Unicode text without splitting astral characters or truncating short tails', () => {
    const text = 'a'.repeat(5999) + '😀' + 'b'.repeat(6001) + 'the end';
    const rows = passages([{ locator: 'page:1', text }]);
    expect(rows.map((p) => p.text).join('')).toBe(text);
    for (const row of rows) {
      expect(row.text).toBe(text.slice(row.start, row.end));
      expect(row.text.length).toBeLessThan(6010);
      expect(row.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(rows.map((p) => p.ordinal)).toEqual([0, 1, 2]);
  });
  it('retains section identity for citations and empty pages', () => {
    const rows = passages([
      { locator: 'page:1', text: 'first' },
      { locator: 'page:2', text: '' },
      { locator: 'page:3', text: 'third' },
    ]);
    expect(rows.map((p) => [p.section, p.locator, p.text])).toEqual([
      [0, 'page:1', 'first'],
      [2, 'page:3', 'third'],
    ]);
  });
  it('preserves a completed-document successor and partial chunk cursor', () => {
    for (const c of [
      { id: 'abc~', chunk: -1 },
      { id: 'abc', chunk: 2 },
    ])
      expect(parseCursor(encodeCursor(c))).toEqual(c);
    expect(() => parseCursor(encodeCursor({ id: 'x', chunk: 1.5 }))).toThrow('INVALID_CURSOR');
  });
});
describe('bounded write admission', () => {
  it('is dry by default and requires exact host for writes', () => {
    expect(parseBillTextArgs(['--source', 'federal'], {}).commit).toBe(false);
    expect(() =>
      parseBillTextArgs(['--source', 'state', '--commit'], { DB_HOST: 'preview' }),
    ).toThrow('DATABASE_HOST_MISMATCH');
    expect(() =>
      parseBillTextArgs(['--source', 'state', '--commit', '--expected-host', 'preview'], {
        DATABASE_URL: 'postgresql://u:p@old/db',
        DB_HOST: 'preview',
      }),
    ).toThrow('DATABASE_HOST_MISMATCH');
    expect(
      parseBillTextArgs(['--source', 'state', '--commit', '--expected-host', 'preview'], {
        DB_HOST: 'preview',
      }).commit,
    ).toBe(true);
  });
  it.each(['0', '-1', '1001', 'NaN', '1.5'])('rejects invalid limit %s', (limit) => {
    expect(() => parseBillTextArgs(['--source', 'federal', `--limit=${limit}`], {})).toThrow(
      'LIMIT_MUST_BE_1_TO_1000',
    );
  });
  it('does not let a commit jump past unfinished durable work', () => {
    expect(() =>
      parseBillTextArgs(
        [
          '--source',
          'federal',
          '--commit',
          '--expected-host',
          'preview',
          '--after',
          encodeCursor({ id: 'a', chunk: 2 }),
        ],
        { DB_HOST: 'preview' },
      ),
    ).toThrow('COMMIT_USES_DURABLE_CURSOR');
  });
});
