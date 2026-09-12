import { normalizeLegiscanCalendar } from './legiscan-calendar.js';
describe('LegiScan calendar observations', () => {
  it('contains malformed dates while retaining unrelated valid observations', () => {
    const n = normalizeLegiscanCalendar('fl-2026-sb123', [
      { date: 'invalid' },
      { date: '2026-02-31' },
      { type: 'hearing', date: '2026-02-24', time: '9:00 AM', description: 'First reading' },
    ]);
    expect(n.completeness).toBe('partial');
    expect(n.issues).toHaveLength(2);
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]?.description).toBe('First reading');
  });
  it('distinguishes absent, malformed and complete empty calendar snapshots', () => {
    expect(normalizeLegiscanCalendar('bill', undefined).completeness).toBe('absent');
    expect(normalizeLegiscanCalendar('bill', null).completeness).toBe('partial');
    expect(normalizeLegiscanCalendar('bill', []).completeness).toBe('complete');
  });
  it('does not collapse same-day same-room events at different times and replays identical versions', () => {
    const item = { type: 'hearing', date: '2026-02-24', location: '412 K', time: '9:00 AM' };
    const n = normalizeLegiscanCalendar('bill', [item, { ...item, time: '2:00 PM' }, item]);
    expect(n.rows).toHaveLength(2);
    expect(normalizeLegiscanCalendar('bill', [item]).rows[0]?.eventKey).toBe(n.rows[0]?.eventKey);
  });
});
