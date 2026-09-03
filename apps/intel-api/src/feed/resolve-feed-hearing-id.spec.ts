import { applyResolvedHearingIds, sessionIdsNeedingHearingId } from './resolve-feed-hearing-id.js';

describe('resolve-feed-hearing-id (legacy feed row backfill, §12)', () => {
  it('collects only sessionIds whose hearingId is missing', () => {
    const ids = sessionIdsNeedingHearingId([
      { evidence: { hearing: { sessionId: 's1', hearingId: null } } },
      { evidence: { hearing: { sessionId: 's2', hearingId: 'cm-119-1' } } },
      { evidence: { hearing: { sessionId: 's3', hearingId: '  ' } } },
      { evidence: { bill: { billId: 'hr1' } } },
      { evidence: { hearing: { sessionId: '', hearingId: null } } },
      { evidence: null },
    ]);
    expect(ids.sort()).toEqual(['s1', 's3']);
  });

  it('stamps hearingId in place without overwriting an existing one', () => {
    const items = [
      { evidence: { hearing: { sessionId: 's1', hearingId: null as string | null, title: 'A' } } },
      { evidence: { hearing: { sessionId: 's2', hearingId: 'cm-119-KEEP', title: 'B' } } },
      { evidence: { hearing: { sessionId: 's-missing', hearingId: null as string | null } } },
    ];
    const map = new Map([
      ['s1', 'cm-119-119533'],
      ['s2', 'cm-119-SHOULD-NOT-APPLY'],
    ]);
    const filled = applyResolvedHearingIds(items, map);
    expect(filled).toBe(1);
    expect((items[0]!.evidence as { hearing: { hearingId: string } }).hearing.hearingId).toBe(
      'cm-119-119533',
    );
    expect((items[1]!.evidence as { hearing: { hearingId: string } }).hearing.hearingId).toBe(
      'cm-119-KEEP',
    );
    expect((items[2]!.evidence as { hearing: { hearingId: string | null } }).hearing.hearingId).toBeNull();
  });

  it('never invents an id from a title', () => {
    const items = [
      {
        evidence: {
          hearing: {
            sessionId: 's-title-only',
            hearingId: null,
            title: 'Industrial Base and Workforce Development for Skilled Trades',
          },
        },
      },
    ];
    expect(applyResolvedHearingIds(items, new Map())).toBe(0);
    expect((items[0]!.evidence as { hearing: { hearingId: null } }).hearing.hearingId).toBeNull();
  });
});
