import { expect, test } from 'vitest';
import { feedExplanation, feedSourceCount, feedStatusText } from './feed-presentation.js';
const item = { sourceType: 'combined', createdAt: '2026-09-20T12:00:00Z',
  evidence: { bill: { billId: '119-hr-8800', displayNum: 'H.R. 8800', stage: 'introduced' } },
  whyItMatters: 'H.R. 8800 (introduced) — a bill you track — was referenced in a hearing.' } as any;
test('shows current status while leaving alert-time evidence untouched', () => {
  expect(feedStatusText({ ...item, currentBillStatus: { label: 'Passed House' } })).toBe('Current status: Passed House');
  expect(feedStatusText(item)).toBe('Recorded with alert on 2026-09-20: introduced');
  expect(feedExplanation(item)).toBe('H.R. 8800 — a bill you track — was referenced in a hearing.');
  expect(item.evidence.bill.stage).toBe('introduced');
  expect(feedExplanation({ ...item, whyItMatters: 'An analyst says introduced provisions matter.' })).toBe('An analyst says introduced provisions matter.');
});
test('hearing rail count includes linked hearing packets without double-counting all sources', () => {
  expect(feedSourceCount({ hearing: 1, combined: 1, bill: 8, state_bill: 7 }, 'hearing')).toBe(2);
  expect(feedSourceCount({ bill: 8 }, 'bill')).toBe(8);
});
