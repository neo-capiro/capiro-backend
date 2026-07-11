import { describe, expect, it } from 'vitest';
import { candidateEmails, formatLastContacted } from './priorContact.js';
import type { OutreachTarget } from './targets.js';

const target = (
  over: Partial<OutreachTarget> & Pick<OutreachTarget, 'type' | 'recipients'>,
): OutreachTarget => ({ key: 'k', cc: [], bcc: [], ...over }) as OutreachTarget;

describe('candidateEmails', () => {
  it('dedupes + lowercases across individual/list/group targets and drops emailless', () => {
    const targets: OutreachTarget[] = [
      target({ type: 'individual', recipients: [{ email: 'A@x.com' }] }),
      target({ type: 'list', recipients: [{ email: 'a@x.com' }, { email: 'b@x.com' }] }),
      target({ type: 'group', recipients: [{ email: 'C@x.com' }, { name: 'No Email' }] }),
    ];
    expect(candidateEmails(targets).sort()).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('returns [] for no targets', () => {
    expect(candidateEmails([])).toEqual([]);
  });
});

describe('formatLastContacted', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  it('renders whole-day counts', () => {
    expect(formatLastContacted('2026-06-29T12:00:00Z', now)).toBe('last contacted 12d ago');
    expect(formatLastContacted('2026-07-10T12:00:00Z', now)).toBe('last contacted 1d ago');
  });
  it('special-cases same-day as "today"', () => {
    expect(formatLastContacted('2026-07-11T01:00:00Z', now)).toBe('last contacted today');
  });
  it('never returns a negative count for a future timestamp', () => {
    expect(formatLastContacted('2026-07-20T12:00:00Z', now)).toBe('last contacted today');
  });
});
