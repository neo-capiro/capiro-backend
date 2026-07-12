import { describe, expect, it } from 'vitest';
import { peToPoolItem } from './pe-context.js';
import type { ProgramElementListItem } from '../../../program-element/types.js';

const pe = (over: Partial<ProgramElementListItem>): ProgramElementListItem =>
  ({
    peCode: '0604270A',
    title: 'Advanced EO Sensor Tech',
    service: 'Air Force',
    budgetActivity: '07',
    appropriationType: 'RDTE',
    status: 'active',
    lastSyncedAt: '2026-07-01',
    ...over,
  }) as ProgramElementListItem;

describe('peToPoolItem (W5.4 funding-block context item)', () => {
  it('leads with the request, tags the current figure vehicle, and states a same-FY direction', () => {
    const item = peToPoolItem(
      pe({
        latestCurrent: 248,
        latestCurrentFy: 2027,
        latestCurrentStage: 'conference',
        latestRequest: 210,
        latestRequestFy: 2027,
      }),
    );
    expect(item.id).toBe('pe-0604270A');
    expect(item.kind).toBe('programElement');
    expect(item.title).toBe('0604270A — Advanced EO Sensor Tech');
    expect(item.sub).toBe('$248.0M · FY27 · Conference');
    expect(item.body).toContain("President's request: $210.0M (FY27)");
    // stage + authorization/appropriations vehicle labeled; direction explicit + correct
    expect(item.body).toContain('Current position: $248.0M (FY27, Conference — appropriations)');
    expect(item.body).toContain('above the request');
    expect(item.body).not.toContain('below the request');
    expect(item.body).toContain('Service: Air Force · Budget Activity: 07');
  });

  it('does NOT state a direction when current and request are different fiscal years', () => {
    const item = peToPoolItem(
      pe({
        latestCurrent: 112.9,
        latestCurrentFy: 2027,
        latestCurrentStage: 'hacd',
        latestRequest: 72.1,
        latestRequestFy: 2026,
      }),
    );
    expect(item.body).toContain('Current position: $112.9M (FY27, HAC-D — appropriations)');
    // the finder derives request/current from independent latest-FY lookups —
    // a cross-FY subtraction is meaningless, so no direction word is emitted.
    expect(item.body).not.toContain('above the request');
    expect(item.body).not.toContain('below the request');
  });

  it('omits the request line when there is no request figure', () => {
    const item = peToPoolItem(
      pe({ latestCurrent: 100, latestCurrentFy: 2026, latestRequest: null }),
    );
    expect(item.body).toContain('Current position: $100.0M (FY26)');
    expect(item.body).not.toContain("President's request:");
  });

  it('handles a PE with no funding figures (no dollar line, no stage/fy noise)', () => {
    const item = peToPoolItem(
      pe({ latestCurrent: null, latestCurrentFy: null, latestCurrentStage: 'none' }),
    );
    expect(item.body).not.toMatch(/\$\d/); // no invented figure
    expect(item.body).toContain('Service: Air Force · Budget Activity: 07');
    expect(item.sub).toBe('—'); // fmtMoneyM(null) = '—'; no fy/stage appended
  });

  it('renders billions for >= $1000M and tags the enacted appropriations vehicle', () => {
    const item = peToPoolItem(
      pe({ latestCurrent: 1500, latestCurrentFy: 2027, latestCurrentStage: 'enacted' }),
    );
    expect(item.body).toContain('Current position: $1.50B (FY27, Enacted — appropriations)');
  });
});
