import { describe, expect, it } from '@jest/globals';
import { TrackerBoardStateSupport } from './tracker-board-state-support.js';
import type { TrackerBoardService } from './tracker-board.service.js';

const support = new TrackerBoardStateSupport();
const host = {} as TrackerBoardService;

describe('Portfolio Tracker lifecycle status', () => {
  it('keeps a federal text-update headline out of the legislative stage', () => {
    expect(support.canonicalStatusFor(host, '119-hr-8800', {
      label: 'H.R. 8800: Bill text updated', tone: 'info',
      changeType: 'text_updated', severity: 'info', at: new Date('2026-11-05T00:00:00Z'),
    }, null, 'passed')).toBe('Passed chamber');
  });

  it('preserves a specific state terminal outcome even with a newer update chip', () => {
    expect(support.canonicalStatusFor(host, 'fl-2026-h0547', {
      label: 'Bill text updated', tone: 'info',
      changeType: 'text_updated', severity: 'info', at: new Date('2026-11-05T00:00:00Z'),
    }, 'failed', 'introduced')).toBe('Failed');
  });

  it('retains the existing stage fallback when the source status is absent', () => {
    expect(support.canonicalStatusFor(host, 'fl-2026-h0547', null, null, 'committee')).toBe('In committee');
  });
});
