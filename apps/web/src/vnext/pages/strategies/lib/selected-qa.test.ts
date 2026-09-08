import { describe, expect, it } from 'vitest';
import { checkFiscalCycle } from '@capiro/strategy-verifier';
import { phaseCoverageGaps, phasesInDateOrder } from './phase-coverage.js';
import { strategyDate, strategyRelativeTime } from './date-format.js';
import { strategyArtifactHref } from './artifact-link.js';

describe('Selected strategy QA regressions', () => {
  it('flags the audited FY27 annual cycle dated in 2027, without inventing replacement deadlines', () => {
    const node = {
      id: 'budget',
      title: "Analyze President's Budget FY27 request baseline",
      startsOn: '2027-01-29',
    };
    expect(checkFiscalCycle([node])).toEqual([
      expect.objectContaining({
        code: 'calendar-cycle-review',
        severity: 'warning',
        nodeIds: ['budget'],
      }),
    ]);
    expect(checkFiscalCycle([{ ...node, startsOn: '2026-04-03' }])).toEqual([]);
    expect(checkFiscalCycle([{ ...node, title: 'FY27 supplemental markup' }])).toEqual([]);
    expect(
      checkFiscalCycle(
        [{ ...node, title: 'Floor amendments' }],
        'Authorization and appropriations ask for FY27',
      ),
    ).toHaveLength(1);
    expect(
      checkFiscalCycle([{ ...node, title: 'Floor amendments' }], 'Compare FY27 and FY28'),
    ).toEqual([]);
  });
  it('unions overlapping phase rows and reports an expired or partially uncovered horizon', () => {
    const rows = [
      { label: 'Discover', startFy: 2026, startQ: 2, endFy: 2026, endQ: 3 },
      { label: 'Strategy', startFy: 2026, startQ: 1, endFy: 2026, endQ: 2 },
      { label: 'Execute', startFy: 2026, startQ: 3, endFy: 2027, endQ: 1 },
    ];
    expect(phasesInDateOrder(rows)).toBe(false);
    expect(phaseCoverageGaps(rows, 2026, 2028)).toEqual(['FY2027 Q1 to FY2029 Q1 (end exclusive)']);
    expect(
      phaseCoverageGaps(
        [...rows, { label: 'Continue', startFy: 2026, startQ: 4, endFy: 2029, endQ: 1 }],
        2026,
        2028,
      ),
    ).toEqual([]);
  });
  it('uses dates with years and truthful minute/hour boundaries', () => {
    const now = Date.parse('2026-09-08T12:00:00Z');
    expect(strategyRelativeTime('2026-09-08T11:30:00Z', now)).toBe('30 min ago');
    expect(strategyRelativeTime('2026-09-08T11:00:00Z', now)).toBe('1 hour ago');
    expect(strategyDate('2027-01-01')).toBe('Jan 1, 2027');
    expect(strategyDate('invalid')).toBe('—');
  });
  it('opens the canonical workspace and outreach draft destinations', () => {
    expect(strategyArtifactHref('workspace_draft', 'doc-1')).toBe('/workspace/draft/doc-1');
    expect(strategyArtifactHref('outreach_record', 'outreach-1')).toBe(
      '/engagement/outreach/draft/outreach-1',
    );
  });
});
