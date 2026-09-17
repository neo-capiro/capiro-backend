import { afterEach, describe, expect, test, vi } from 'vitest';
import { createFundingOpportunityV2KeywordController } from './funding-opportunities-v2-keyword.js';

describe('Funding Opportunities v2 keyword controller', () => {
  afterEach(() => vi.useRealTimers());

  test('Search commits the latest input before the debounce threshold', () => {
    vi.useFakeTimers();
    const controller = createFundingOpportunityV2KeywordController();
    const committed: string[] = [];
    controller.update('old', (value) => committed.push(value));
    controller.commit('latest', (value) => committed.push(value));
    vi.advanceTimersByTime(299);
    expect(committed).toEqual(['latest']);
    controller.dispose();
  });

  test('Clear cancels pending input so stale text cannot resurrect', () => {
    vi.useFakeTimers();
    const controller = createFundingOpportunityV2KeywordController();
    const committed: string[] = [];
    controller.update('stale', (value) => committed.push(value));
    controller.cancel();
    vi.advanceTimersByTime(300);
    expect(committed).toEqual([]);
    controller.dispose();
  });
});
