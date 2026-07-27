import { renderDigestEmail, type DigestItem } from '../src/tracker/tracker-email.templates.js';

/**
 * MP-01: digest items claimed to sort by legislative stage, but the OLD
 * `STAGE_RANK` keyed on `toneColor`'s vocabulary (critical/notable/info/
 * success) against `item.label`, which is a free-text stage description
 * ("Passed a chamber", never literally one of those four words) — so
 * `STAGE_RANK[a.label.toLowerCase()] ?? 4` was ALWAYS 4 for every real item,
 * making the comparator a total no-op that silently fell through to the next
 * sort key (deadline) every time. Fixed by reusing `billStage()`
 * (`@capiro/shared`) — the same classifier the tracker BOARD already uses for
 * its four columns — against `item.detail` (the real action text), instead of
 * inventing a parallel rank keyed on a field that was never going to match.
 */
function item(over: Partial<DigestItem>): DigestItem {
  return {
    clientName: 'Acme Corp',
    displayNum: 'H.R. 1',
    billTitle: 'Test Act',
    label: 'Update',
    severity: 'notable', // SAME severity on every fixture below — isolates the stage key
    detail: 'Some action.',
    actionDate: null,
    deadline: null,
    recommendedAction: null,
    why: null,
    url: '',
    appUrl: 'https://app.capiro.ai/legiwatch?tab=feed&client=c1&alert=a1',
    ...over,
  };
}

describe('renderDigestEmail — stage ordering (MP-01)', () => {
  it("the plan's exact fixture: 'Became law', 'Passed a chamber', 'Hearing scheduled' come back in that order", () => {
    const items: DigestItem[] = [
      // Deliberately enqueued out of significance order.
      item({ label: 'Hearing scheduled', detail: 'Hearing scheduled for June 1.' }),
      item({ label: 'Became law', detail: 'Became Public Law No. 119-1.' }),
      item({ label: 'Passed a chamber', detail: 'On passage Passed the House by recorded vote: 219 - 210.' }),
    ];
    const { text } = renderDigestEmail('daily', items);
    const idxLaw = text.indexOf('Became law');
    const idxChamber = text.indexOf('Passed a chamber');
    const idxHearing = text.indexOf('Hearing scheduled');
    expect(idxLaw).toBeGreaterThanOrEqual(0);
    expect(idxChamber).toBeGreaterThan(idxLaw);
    expect(idxHearing).toBeGreaterThan(idxChamber);
  });

  it('is not a no-op: two same-severity items with different real stages are NOT left in enqueue order', () => {
    const items: DigestItem[] = [
      item({ label: 'Hearing scheduled', detail: 'Hearing scheduled for June 1.', displayNum: 'FIRST-ENQUEUED' }),
      item({ label: 'Became law', detail: 'Signed by the President.', displayNum: 'SECOND-ENQUEUED' }),
    ];
    const { text } = renderDigestEmail('daily', items);
    // Before the fix, both items ranked 4 (unmatched) and fell through to the
    // deadline tiebreak (both null here) and then recommendedAction (both
    // absent here) — i.e. STABLE SORT preserves enqueue order, so
    // FIRST-ENQUEUED would incorrectly precede SECOND-ENQUEUED.
    expect(text.indexOf('SECOND-ENQUEUED')).toBeLessThan(text.indexOf('FIRST-ENQUEUED'));
  });

  it('severity still outranks stage: a critical hearing-scheduled item precedes a notable enacted item', () => {
    const items: DigestItem[] = [
      item({ label: 'Became law', detail: 'Signed by the President.', severity: 'notable', displayNum: 'ENACTED-NOTABLE' }),
      item({ label: 'Hearing scheduled', detail: 'Hearing scheduled.', severity: 'critical', displayNum: 'HEARING-CRITICAL' }),
    ];
    const { text } = renderDigestEmail('daily', items);
    expect(text.indexOf('HEARING-CRITICAL')).toBeLessThan(text.indexOf('ENACTED-NOTABLE'));
  });
});
