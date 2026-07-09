import { senateRollId, resolveSenateBillId, parseSenateVoteDate } from './sync-senate-votes';

describe('senateRollId', () => {
  it('formats the canonical roll id', () => {
    expect(senateRollId(119, 2, 192)).toBe('senate-119-2-192');
  });
});

describe('resolveSenateBillId', () => {
  it('parses a bill designation from document_name', () => {
    expect(resolveSenateBillId('S.J.Res. 185', undefined, 119)).toBe('119-sjres-185');
    expect(resolveSenateBillId('H.R. 8800', undefined, 119)).toBe('119-hr-8800');
  });
  it('skips nominations/treaties and falls back to the menu issue', () => {
    expect(resolveSenateBillId('PN938-2', 'S. 1', 119)).toBe('119-s-1');
    expect(resolveSenateBillId('PN938-2', undefined, 119)).toBeNull();
    expect(resolveSenateBillId('Treaty Doc. 118-1', undefined, 119)).toBeNull();
  });
  it('falls back to issue when document_name is empty', () => {
    expect(resolveSenateBillId(undefined, 'H.R. 8800', 119)).toBe('119-hr-8800');
  });
});

describe('parseSenateVoteDate', () => {
  it('parses the LIS date form (with the double comma + time) at UTC — TZ-stable', () => {
    const d = parseSenateVoteDate('June 24, 2026,  10:30 PM', 2026);
    expect(d.toISOString().slice(0, 10)).toBe('2026-06-24'); // UTC, no off-by-one on any host
  });
  it('falls back to Jan 1 of the congress year on a bad date', () => {
    const d = parseSenateVoteDate('garbage', 2025);
    expect(d.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });
});
