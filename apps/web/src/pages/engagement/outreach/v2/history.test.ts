// Draft version history for the "Improve"/Revert affordance (W2.6). Proves the
// keep-last-2 snapshot + one-click revert invariants the wizard relies on.
import { describe, expect, it } from 'vitest';
import { appendDraftHistory, revertDraftHistory } from './generation';

describe('appendDraftHistory', () => {
  it('returns undefined when there is no prior draft', () => {
    expect(appendDraftHistory(undefined)).toBeUndefined();
  });

  it('snapshots the prior draft', () => {
    const h = appendDraftHistory({ subject: 'S1', body: 'B1' });
    expect(h).toEqual([{ subject: 'S1', body: 'B1' }]);
  });

  it('keeps only the newest 2 versions', () => {
    const h = appendDraftHistory({
      subject: 'S3',
      body: 'B3',
      history: [
        { subject: 'S1', body: 'B1' },
        { subject: 'S2', body: 'B2' },
      ],
    });
    // oldest (S1) dropped; newest snapshot (S3) kept
    expect(h).toEqual([
      { subject: 'S2', body: 'B2' },
      { subject: 'S3', body: 'B3' },
    ]);
    expect(h).toHaveLength(2);
  });
});

describe('revertDraftHistory', () => {
  it('returns null when there is nothing to revert', () => {
    expect(revertDraftHistory({ subject: 'S', body: 'B' })).toBeNull();
    expect(revertDraftHistory({ subject: 'S', body: 'B', history: [] })).toBeNull();
  });

  it('pops the newest version and returns the remaining history', () => {
    const result = revertDraftHistory({
      subject: 'current',
      body: 'current body',
      history: [
        { subject: 'S1', body: 'B1' },
        { subject: 'S2', body: 'B2' },
      ],
    });
    expect(result).toEqual({
      subject: 'S2',
      body: 'B2',
      history: [{ subject: 'S1', body: 'B1' }],
    });
  });

  it('round-trips: append then revert restores the original', () => {
    const original = { subject: 'orig', body: 'orig body' };
    const history = appendDraftHistory(original)!;
    const afterImprove = { subject: 'improved', body: 'improved body', history };
    const reverted = revertDraftHistory(afterImprove)!;
    expect(reverted.subject).toBe('orig');
    expect(reverted.body).toBe('orig body');
    expect(reverted.history).toEqual([]);
  });
});
