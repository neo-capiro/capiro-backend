import { describe, expect, it } from '@jest/globals';
import { buildBaselineEntries, parseReferencePayload } from './baseline.js';

describe('reference baseline', () => {
  const now = new Date(2027, 0, 15); // CUR_FY 2027

  it('builds the full baseline: 16 congress + 9 ppbe lane bars + 3 current phases', () => {
    const rows = buildBaselineEntries(now);
    const byKind = (k: string) => rows.filter((r) => r.kind === k);
    expect(byKind('congress_milestone')).toHaveLength(16);
    expect(byKind('ppbe_lane_bar')).toHaveLength(9);
    expect(byKind('ppbe_current_phase')).toHaveLength(3);
  });

  it('congress milestones carry real dates and no fy; current phases carry fy and no dates', () => {
    const rows = buildBaselineEntries(now);
    const congress = rows.filter((r) => r.kind === 'congress_milestone');
    for (const r of congress) {
      expect(r.startsOn).toBeInstanceOf(Date);
      expect(r.endsOn).toBeInstanceOf(Date);
      expect(r.fy).toBeNull();
    }
    const phases = rows.filter((r) => r.kind === 'ppbe_current_phase');
    expect(phases.map((p) => p.fy)).toEqual([2027, 2028, 2029]);
    for (const p of phases) {
      expect(p.startsOn).toBeNull();
      expect(p.endsOn).toBeNull();
    }
  });

  it('parseReferencePayload accepts a valid array and normalizes dates', () => {
    const rows = parseReferencePayload(
      JSON.stringify([
        { kind: 'congress_milestone', label: 'Markup', startsOn: '2027-05-01', endsOn: '2027-06-01', tone: 'notable', position: 0 },
        { kind: 'ppbe_current_phase', label: 'Execution', fy: 2027, position: 0, active: true },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.startsOn).toBeInstanceOf(Date);
    expect(rows[1]!.fy).toBe(2027);
    expect(rows[1]!.startsOn).toBeNull();
  });

  it('parseReferencePayload rejects malformed payloads', () => {
    expect(() => parseReferencePayload('not json')).toThrow(/not valid JSON/);
    expect(() => parseReferencePayload('{}')).toThrow(/must be a JSON array/);
    expect(() => parseReferencePayload('[{"kind":"bogus","label":"x","position":0}]')).toThrow(
      /invalid kind/,
    );
    expect(() =>
      parseReferencePayload('[{"kind":"congress_milestone","label":"x","position":0,"startsOn":"nope"}]'),
    ).toThrow(/not a valid date/);
    expect(() =>
      parseReferencePayload('[{"kind":"congress_milestone","position":0}]'),
    ).toThrow(/label is required/);
  });
});
