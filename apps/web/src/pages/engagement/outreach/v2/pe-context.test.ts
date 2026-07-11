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
  it('renders the canonical-current funding block with FY + stage', () => {
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
    expect(item.body).toContain('Current: $248.0M (FY27 · Conference)');
    expect(item.body).toContain('Request: $210.0M (FY27)');
    expect(item.body).toContain('Service: Air Force · Budget Activity: 07');
  });

  it('omits the Request line when there is no request figure', () => {
    const item = peToPoolItem(
      pe({ latestCurrent: 100, latestCurrentFy: 2026, latestRequest: null }),
    );
    expect(item.body).toContain('Current: $100.0M (FY26)');
    expect(item.body).not.toContain('Request:');
  });

  it('handles a PE with no funding figures (— dashes, no stage/fy noise)', () => {
    const item = peToPoolItem(
      pe({ latestCurrent: null, latestCurrentFy: null, latestCurrentStage: 'none' }),
    );
    expect(item.body).toContain('Current: —');
    expect(item.sub).toBe('—'); // fmtMoneyM(null) = '—'; no fy/stage appended
  });

  it('renders billions for >= $1000M', () => {
    const item = peToPoolItem(
      pe({ latestCurrent: 1500, latestCurrentFy: 2027, latestCurrentStage: 'enacted' }),
    );
    expect(item.body).toContain('Current: $1.50B (FY27 · Enacted)');
  });
});
