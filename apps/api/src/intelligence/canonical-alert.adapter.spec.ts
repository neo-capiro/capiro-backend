import { toCanonicalAlert } from './canonical-alert.adapter.js';

describe('intelligence → canonical Alert adapter (SC1.1/SC1.2)', () => {
  it('treats `when` as a deadline ONLY when a countdown exists', () => {
    const withCountdown = toCanonicalAlert(
      {
        type: 'comment_deadline',
        title: 'Comment period closing',
        subtitle: 'Rule affects client',
        when: '2026-08-01',
        countdownDays: 12,
      },
      'c1',
    );
    expect(withCountdown.alert.deadline).toBe('2026-08-01');
    const withoutCountdown = toCanonicalAlert(
      {
        type: 'competitor_filing',
        title: 'Competitor filed',
        subtitle: 'x',
        when: '2026-07-01',
        countdownDays: null,
      },
      'c1',
    );
    expect(withoutCountdown.alert.deadline).toBeNull();
  });

  it('flags issueId/whoActs (no source) instead of aliasing the category in', () => {
    const out = toCanonicalAlert(
      { type: 'comment_deadline', title: 't', subtitle: 's', when: '2026-08-01', countdownDays: 3 },
      'c1',
    );
    expect(out.alert.sourceType).toBe('comment_deadline');
    expect(out.alert.issueId).toBe('');
    expect(out.complete).toBe(false);
    expect(out.missingFields).toEqual(expect.arrayContaining(['issueId', 'whoActs']));
  });

  it('unknown categories omit sourceType, never throw', () => {
    const out = toCanonicalAlert({ type: 'weird', title: 't', subtitle: 's' }, 'c1');
    expect(out.alert.sourceType).toBeUndefined();
  });
});
