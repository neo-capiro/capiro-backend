// dedupeOutreachRecipients (W0.4): server-side, defense-in-depth collapse of
// duplicate recipients before the billable per-recipient AI fan-out. Keyed on
// the SAME id chain the batch worker uses to map results back
// (id → directoryContactId → email → name), keep-first.

import { describe, expect, test } from '@jest/globals';
import { dedupeOutreachRecipients } from './engagement.service.js';

// The helper is typed to OutreachRecipientInput but only reads the id chain; the
// tests pass minimal shapes cast through unknown.
const rs = (arr: Array<Record<string, unknown>>) =>
  dedupeOutreachRecipients(arr as unknown as Parameters<typeof dedupeOutreachRecipients>[0]);

describe('dedupeOutreachRecipients', () => {
  test('collapses an exact-duplicate email, keep-first', () => {
    const out = rs([
      { email: 'dana@mail.house.gov', name: 'Dana' },
      { email: 'dana@mail.house.gov', name: 'Dana (dup)' },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as { name: string }).name).toBe('Dana');
  });

  test('keeps case-variant emails DISTINCT (matches the worker/frontend key exactly)', () => {
    // The key must not normalize case: the batch worker keys results by the raw
    // email, so collapsing 'Dana@…' and 'dana@…' here would leave the second
    // recipient's slot with no matching result — a silent drop.
    const out = rs([
      { email: 'Dana@mail.house.gov', name: 'Dana' },
      { email: 'dana@mail.house.gov', name: 'dana' },
    ]);
    expect(out).toHaveLength(2);
  });

  test('collapses by id ahead of email', () => {
    const out = rs([
      { id: 'r1', email: 'a@x.com' },
      { id: 'r1', email: 'different@x.com' },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as { email: string }).email).toBe('a@x.com');
  });

  test('collapses by directoryContactId when there is no id', () => {
    const out = rs([{ directoryContactId: 'd1' }, { directoryContactId: 'd1' }]);
    expect(out).toHaveLength(1);
  });

  test('keeps distinct recipients untouched and in order', () => {
    const out = rs([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }]);
    expect(out.map((r) => (r as { email: string }).email)).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });

  test('never drops entries that have no usable key (worker falls back to index)', () => {
    const out = rs([{}, {}]);
    expect(out).toHaveLength(2);
  });
});
