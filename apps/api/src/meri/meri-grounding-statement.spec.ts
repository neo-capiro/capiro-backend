import { describe, expect, it } from '@jest/globals';
import { buildMeriGroundingStatement } from './meri-grounding-statement.js';

describe('buildMeriGroundingStatement', () => {
  it('uses server-provided grounding facts without manufacturing client copy', () => {
    expect(
      buildMeriGroundingStatement({
        citations: [{ n: 1, type: 'report', id: 'r1', title: 'Report', url: null, snippet: null, tool: 'search' }],
        verification: { totalCount: 3, unsupportedCount: 0 },
        groundingCaveat: null,
      }),
    ).toBe('Grounded in 1 retrieved source; 3 claims were checked against retrieved sources.');
  });

  it('prioritizes a server-detected grounding caveat over ordinary source counts', () => {
    expect(
      buildMeriGroundingStatement({
        citations: [{ n: 1, type: 'report', id: 'r1', title: 'Report', url: null, snippet: null, tool: 'search' }],
        verification: { totalCount: 3, unsupportedCount: 1 },
        groundingCaveat: { topSeverity: 'high', findings: [{ check: 'citation', severity: 'high', detail: 'One claim is not supported.' }] },
      }),
    ).toBe('Grounding review flagged 1 issue. Verify the cited evidence before relying on this answer.');
  });

  it('truthfully reports the absence of retrieved sources', () => {
    expect(
      buildMeriGroundingStatement({ citations: [], verification: null, groundingCaveat: null }),
    ).toBe('No retrieved sources were attached to this answer.');
  });
});
