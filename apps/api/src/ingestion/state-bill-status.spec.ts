import {
  deriveStateBillStatus,
  classifyStateVoteMotion,
  humanizeStateBillKey,
  stateBillSessionLabel,
  stateBillStatusLabel,
  parseStateBillDesignation,
} from '@capiro/shared';

describe('deriveStateBillStatus — all 12 statuses', () => {
  it('enacted: progress 8 (Chaptered)', () => {
    expect(
      deriveStateBillStatus({ progressEvents: [{ event: 8, date: '2025-06-01' }] }).status,
    ).toBe('enacted');
  });
  it('enacted: status 4 (Passed)', () => {
    expect(deriveStateBillStatus({ legiscanStatus: 4 }).status).toBe('enacted');
  });
  it('veto_overridden: overridden flag', () => {
    expect(deriveStateBillStatus({ overridden: true }).status).toBe('veto_overridden');
  });
  it('vetoed: status 5', () => {
    expect(deriveStateBillStatus({ legiscanStatus: 5 }).status).toBe('vetoed');
  });
  it('failed: status 6', () => {
    expect(deriveStateBillStatus({ legiscanStatus: 6 }).status).toBe('failed');
  });
  it('to_governor: status 3 (Enrolled)', () => {
    expect(deriveStateBillStatus({ legiscanStatus: 3 }).status).toBe('to_governor');
  });
  it('dead_by_deadline: sine die passed, no terminal signal', () => {
    const r = deriveStateBillStatus({
      legiscanStatus: 1,
      sessionSineDie: '2025-05-30',
      today: '2025-07-01',
    });
    expect(r.status).toBe('dead_by_deadline');
    expect(r.label).toMatch(/dead|sine die/i);
  });
  it('resolving: conference-committee language', () => {
    expect(
      deriveStateBillStatus({ latestActionText: 'Conference committee appointed' }).status,
    ).toBe('resolving');
  });
  it('passed_chamber: status 2 (Engrossed)', () => {
    expect(deriveStateBillStatus({ legiscanStatus: 2 }).status).toBe('passed_chamber');
  });
  it('reported: progress 10 (Report Pass)', () => {
    expect(
      deriveStateBillStatus({ progressEvents: [{ event: 10, date: '2025-02-01' }] }).status,
    ).toBe('reported');
  });
  it('committee: referred/hearing/markup text', () => {
    expect(
      deriveStateBillStatus({ latestActionText: 'Referred to Committee on State Affairs' }).status,
    ).toBe('committee');
  });
  it('floor: calendar/reading text', () => {
    expect(deriveStateBillStatus({ latestActionText: 'Placed on the Local Calendar' }).status).toBe(
      'floor',
    );
  });
  it('introduced: no signal at all', () => {
    expect(deriveStateBillStatus({}).status).toBe('introduced');
  });
});

describe('deriveStateBillStatus — precedence traps', () => {
  it('TRAP 1 (the state twin of the H.R. 8800 lesson): engrossed + sine-die passed -> dead_by_deadline, NOT passed_chamber', () => {
    const r = deriveStateBillStatus({
      legiscanStatus: 2, // Engrossed -> would read passed_chamber in isolation
      sessionSineDie: '2025-05-30',
      today: '2025-07-01',
    });
    expect(r.status).toBe('dead_by_deadline');
  });

  it('TRAP 2: enrolled beats sine-die — to_governor is a hard terminal, checked before the deadline test', () => {
    const r = deriveStateBillStatus({
      legiscanStatus: 3, // Enrolled
      sessionSineDie: '2025-05-30',
      today: '2025-07-01',
    });
    expect(r.status).toBe('to_governor');
  });

  it('TRAP 3: a real failed floor vote outranks sine-die too (failed is a hard terminal)', () => {
    const r = deriveStateBillStatus({
      failedChamber: true,
      sessionSineDie: '2025-05-30',
      today: '2025-07-01',
    });
    expect(r.status).toBe('failed');
  });

  it('TRAP 4 (frozen fixture, S3-E): progress 7 (Override) beats status 5 (Vetoed) — override is checked first', () => {
    const r = deriveStateBillStatus({
      legiscanStatus: 5, // Vetoed — would read "vetoed" in isolation
      progressEvents: [{ event: 7, date: '2025-06-10' }],
    });
    expect(r.status).toBe('veto_overridden');
  });

  it('TRAP 5 (frozen fixture, S3-E): progress 10 (Report Pass) -> reported even with committee-ish text present', () => {
    const r = deriveStateBillStatus({
      latestActionText: 'Referred to Committee on State Affairs', // would read "committee" via regex fallback alone
      progressEvents: [{ event: 10, date: '2025-02-01' }],
    });
    expect(r.status).toBe('reported');
  });

  it('TRAP 6 (S3-D, the pinned crossover-dead fixture — state twin of H.R. 8800): a real bill that died at crossover with misleading committee-ish final action text reads dead, not "in committee"', () => {
    const r = deriveStateBillStatus({
      legiscanStatus: 1,
      latestActionText: 'Referred to Committee on State Affairs',
      sessionSineDie: '2025-05-30',
      today: '2026-01-01',
    });
    expect(r.status).toBe('dead_by_deadline');
    expect(r.status).not.toBe('committee');
  });
});

describe('classifyStateVoteMotion', () => {
  it('recognizes final-passage motions', () => {
    for (const m of ['Third Reading', 'Final Passage', 'On Passage', 'Do Pass', 'Motion to Concur'])
      expect(classifyStateVoteMotion(m)).toBe(true);
  });
  it('excludes committee/amendment motions even if they mention passage-like words', () => {
    for (const m of ['Committee Amendment adopted', 'House Committee on Passage of Rules'])
      expect(classifyStateVoteMotion(m)).toBe(false);
  });
  it('is false on empty/unrelated motions', () => {
    expect(classifyStateVoteMotion(null)).toBe(false);
    expect(classifyStateVoteMotion('Motion to Table')).toBe(false);
  });
});

describe('humanizeStateBillKey', () => {
  it('formats the DD1 key for display', () => {
    expect(humanizeStateBillKey('tx-2025-hb1234')).toBe('TX HB 1234');
  });
  it('handles a special-session key', () => {
    expect(humanizeStateBillKey('tx-2025x1987-hb1234')).toBe('TX HB 1234');
  });
  it('passes through a malformed key unchanged', () => {
    expect(humanizeStateBillKey('not-a-key')).toBe('not-a-key');
  });
});

describe('stateBillSessionLabel', () => {
  it('labels a regular session as-is', () => {
    expect(stateBillSessionLabel('2025')).toBe('2025');
  });
  it('labels a special session', () => {
    expect(stateBillSessionLabel('2025x1987')).toBe('2025 (special session)');
  });
});

describe('stateBillStatusLabel', () => {
  it('resolves a known status', () => {
    expect(stateBillStatusLabel('dead_by_deadline')).toMatch(/dead|sine die/i);
  });
  it('passes through an unknown value', () => {
    expect(stateBillStatusLabel('bogus')).toBe('bogus');
    expect(stateBillStatusLabel(null)).toBe('Unknown');
  });
});

describe('parseStateBillDesignation', () => {
  it('a bare bill number + an explicit state hint resolves correctly (S6 tool contract)', () => {
    // REGRESSION: a naive text-first parse misreads the "HB" bill-type prefix
    // as a bogus 2-letter state code and ignores the real `state` param.
    const r = parseStateBillDesignation('HB 1234', 'TX');
    expect(r?.state).toBe('TX');
    expect(r?.billNumber).toBe('hb1234');
  });

  it('a state embedded in the text resolves with no hint needed', () => {
    const r = parseStateBillDesignation('TX HB 1234', null);
    expect(r?.state).toBe('TX');
    expect(r?.billNumber).toBe('hb1234');
  });

  it('a REDUNDANT state hint matching the embedded state still resolves (both interpretations agree)', () => {
    const r = parseStateBillDesignation('TX HB 1234', 'TX');
    expect(r?.state).toBe('TX');
    expect(r?.billNumber).toBe('hb1234');
  });

  it('no state anywhere (embedded or hinted) returns null — never guesses a state from the bill type', () => {
    expect(parseStateBillDesignation('HB 1234', null)).toBeNull();
    expect(parseStateBillDesignation('HJR 12', null)).toBeNull();
  });

  it('builds the canonical key when a sessionKey is supplied', () => {
    const r = parseStateBillDesignation('HB 1234', 'TX', '2025');
    expect(r?.key).toBe('tx-2025-hb1234');
  });

  it('key is null without a sessionKey — caller joins to a session separately', () => {
    const r = parseStateBillDesignation('TX HB 1234', null);
    expect(r?.key).toBeNull();
  });

  it('handles punctuation variants ("H.B. 1234")', () => {
    const r = parseStateBillDesignation('H.B. 1234', 'TX');
    expect(r?.billNumber).toBe('hb1234');
  });

  it('handles an alpha-suffixed resolution number ("HJR12A")', () => {
    const r = parseStateBillDesignation('HJR12A', 'TX');
    expect(r?.billNumber).toBe('hjr12a');
  });
});
