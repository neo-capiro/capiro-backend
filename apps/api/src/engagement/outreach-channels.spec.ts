// W5 context-channel logic that isn't a plain query: the tolerant committee-name
// match + cap in renderRecipientHearings (directory and hearing committee names
// drift, so the match is case-insensitive and bidirectional-contains).

import { describe, expect, test } from '@jest/globals';
import { EngagementService, scrubPiiForVoice } from './engagement.service.js';

function renderHearings(
  hearings: Array<{ committeeName: string; chamber: string; title: string; date: Date }>,
  committees: string[],
): string | null {
  const svc = Object.create(EngagementService.prototype) as EngagementService;
  return (
    svc as unknown as {
      renderRecipientHearings(h: typeof hearings, c: string[]): string | null;
    }
  ).renderRecipientHearings(hearings, committees);
}

const H = (committeeName: string, title: string, iso: string) => ({
  committeeName,
  chamber: 'House',
  title,
  date: new Date(iso),
});

describe('renderRecipientHearings (W5.3)', () => {
  test('matches a committee case-insensitively and bidirectionally', () => {
    const out = renderHearings(
      [H('House Committee on Armed Services', 'FY27 posture', '2026-07-20T00:00:00Z')],
      ['Armed Services'], // recipient committee is a substring of the hearing name
    );
    expect(out).toContain('FY27 posture');
    expect(out).toContain('2026-07-20');
  });

  test('returns null when no committee matches (no fabrication)', () => {
    const out = renderHearings(
      [H('Committee on Agriculture', 'Farm bill', '2026-07-20T00:00:00Z')],
      ['Armed Services'],
    );
    expect(out).toBeNull();
  });

  test('returns null with no committees or no hearings', () => {
    expect(renderHearings([], ['Armed Services'])).toBeNull();
    expect(renderHearings([H('Armed Services', 't', '2026-07-20T00:00:00Z')], [])).toBeNull();
  });

  test('caps at 3 matches', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      H('Armed Services', `hearing ${i}`, `2026-07-2${i}T00:00:00Z`),
    );
    const out = renderHearings(many, ['Armed Services'])!;
    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(3);
  });
});

describe('scrubPiiForVoice (W5.6)', () => {
  test('strips HTML and redacts emails + phone numbers', () => {
    const out = scrubPiiForVoice(
      '<p>Hi Dana, reach me at uma.sender@firm.com or +1 (202) 555-0142.</p>',
    );
    expect(out).not.toMatch(/@firm\.com/);
    expect(out).not.toMatch(/555-0142/);
    expect(out).toContain('[email]');
    expect(out).toContain('[phone]');
    expect(out).not.toContain('<p>');
  });

  test('regex guard: NO email address survives scrubbing', () => {
    const samples = [
      'Contact a@b.co',
      'Multiple foo.bar+tag@sub.domain.gov and baz@x.io here',
      '<div>staffer@mail.house.gov</div>',
    ];
    for (const s of samples) {
      expect(scrubPiiForVoice(s)).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    }
  });
});
