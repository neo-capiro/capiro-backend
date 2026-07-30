import { describe, expect, it } from 'vitest';
import { settingsMemorySuccessMessage } from './MemoryFileEditor.js';

describe('MemoryFileEditor Phase 3 result wording', () => {
  it('never labels a shared candidate submission as Saved', () => {
    expect(
      settingsMemorySuccessMessage({
        status: 'pending_review',
        candidateId: 'cand-1',
        activeItemUnchanged: true,
      }),
    ).toBe('Submitted for independent review');
  });

  it('keeps the immediate personal-save wording', () => {
    expect(settingsMemorySuccessMessage({ ok: true, updatedAt: 'now' })).toBe('Saved');
  });
});
