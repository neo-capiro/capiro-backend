import {
  classifyChange,
  classifyStatusChange,
  cosponsorMomentumClass,
  dedupeByChangeType,
  parseTally,
  selectMaterialEvents,
  severityToMateriality,
  FISCAL_NOTE_CLASS,
  TEXT_CHANGED_CLASS,
  HEARING_SCHEDULED_CLASS,
  NEW_MATCH_CLASS,
  type ActionLike,
  type MaterialEvent,
} from '../src/tracker/change-detector.util.js';

/** Phase 3 (plan §6.3): classifyChange cascade parity with legacy. */
describe('classifyChange', () => {
  const cases: Array<[string, string, string, string]> = [
    ['Became Public Law No. 118-1', 'bill_enacted', 'critical', 'enactedFailed'],
    ['Presented to President.', 'bill_to_president', 'critical', 'enactedFailed'],
    // GAI-07: bill_failed now requires MEASURE-level failure context (a bare
    // "Motion to table agreed to" — tabling of WHAT? — no longer fires a
    // critical alert; see the dedicated adversarial block below).
    ['Failed of passage in Senate', 'bill_failed', 'critical', 'enactedFailed'],
    ['Motion to table the bill agreed to', 'bill_failed', 'critical', 'enactedFailed'],
    ['Passed/agreed to in House', 'bill_passed_chamber', 'notable', 'floorVote'],
    [
      'Rules Committee Resolution H. Res. 5 provides for consideration',
      'bill_rule_reported',
      'notable',
      'floorVote',
    ],
    ['Placed on Union Calendar', 'bill_floor_scheduled', 'notable', 'floorVote'],
    ['Ordered to be Reported', 'bill_reported', 'notable', 'committeeVote'],
    ['Committee Consideration and Mark-up Session Held', 'bill_markup', 'notable', 'committeeVote'],
    ['Subcommittee Hearing Held', 'bill_hearing', 'info', 'hearing'],
    ['House Amendment 12 agreed to', 'bill_amendment', 'notable', 'amendment'],
  ];
  it.each(cases)('%s → %s', (text, changeType, severity, triggerKey) => {
    const c = classifyChange(text);
    expect(c).not.toBeNull();
    expect(c!.changeType).toBe(changeType);
    expect(c!.severity).toBe(severity);
    expect(c!.triggerKey).toBe(triggerKey);
  });

  it('bill_rule_reported uses floorVote (not committeeVote) — parity correction', () => {
    expect(classifyChange('closed rule')!.triggerKey).toBe('floorVote');
  });

  it('returns null for routine churn / empty', () => {
    expect(classifyChange('Referred to the Committee on Armed Services.')).toBeNull();
    expect(classifyChange(null)).toBeNull();
    expect(classifyChange('')).toBeNull();
  });

  it('GAI-07: procedural failures / veto threats are NOT bill failure (parity with legacy)', () => {
    expect(classifyChange('Motion to recommit failed by voice vote.')?.changeType).not.toBe(
      'bill_failed',
    );
    expect(
      classifyChange('Cloture motion rejected by Yea-Nay Vote. 55 - 45.')?.changeType,
    ).not.toBe('bill_failed');
    expect(
      classifyChange('Passed House 220-210; the White House has issued a veto threat.')?.changeType,
    ).toBe('bill_passed_chamber');
    expect(classifyChange('Motion to table agreed to.')).toBeNull();
  });
});

describe('selectMaterialEvents', () => {
  const d = (s: string): Date => new Date(s + 'T00:00:00Z');
  it('returns one event per changeType, chronological', () => {
    const actions: ActionLike[] = [
      { date: d('2026-01-02'), text: 'Ordered to be Reported' },
      { date: d('2026-01-05'), text: 'Passed/agreed to in House' },
      { date: d('2026-01-03'), text: 'Committee markup' },
    ];
    const evs = selectMaterialEvents(actions, null);
    expect(evs.map((e) => e.cls.changeType)).toEqual([
      'bill_reported',
      'bill_markup',
      'bill_passed_chamber',
    ]);
  });
  it('dedupes by changeType', () => {
    const actions: ActionLike[] = [
      { date: d('2026-01-01'), text: 'Subcommittee Hearing Held' },
      { date: d('2026-01-02'), text: 'Full Committee Hearing Held' },
    ];
    expect(selectMaterialEvents(actions, null)).toHaveLength(1);
  });
  it('merges the latest action when not already present', () => {
    const evs = selectMaterialEvents([], { date: d('2026-02-01'), text: 'Became Public Law' });
    expect(evs).toHaveLength(1);
    expect(evs[0].cls.changeType).toBe('bill_enacted');
  });
});

describe('severityToMateriality', () => {
  it('maps severity → materiality', () => {
    expect(severityToMateriality('critical')).toBe('high');
    expect(severityToMateriality('notable')).toBe('medium');
    expect(severityToMateriality('info')).toBe('low');
  });
});

// ── LegiWatch B: derived (non-action-text) emitters ──────────────────────────
describe('classifyStatusChange (B5 rule outcome)', () => {
  it('rule_failed → critical bill_rule_failed on the floorVote key', () => {
    const c = classifyStatusChange('rule_failed');
    expect(c).not.toBeNull();
    expect(c!.changeType).toBe('bill_rule_failed');
    expect(c!.triggerKey).toBe('floorVote');
    expect(c!.severity).toBe('critical');
    expect(c!.label).toMatch(/stall/i);
  });
  it('floor (rule adopted) → notable bill_rule_adopted', () => {
    const c = classifyStatusChange('floor');
    expect(c!.changeType).toBe('bill_rule_adopted');
    expect(c!.triggerKey).toBe('floorVote');
    expect(c!.severity).toBe('notable');
  });
  it('returns null for statuses the action-text path already emits (no dupes)', () => {
    for (const s of [
      'enacted',
      'failed',
      'passed_chamber',
      'committee',
      'introduced',
      null,
      undefined,
    ])
      expect(classifyStatusChange(s)).toBeNull();
  });
});

describe('cosponsorMomentumClass (B8)', () => {
  it('is sponsorMomentum-keyed and scales severity with the surge', () => {
    expect(cosponsorMomentumClass(6).triggerKey).toBe('sponsorMomentum');
    expect(cosponsorMomentumClass(6).severity).toBe('info');
    expect(cosponsorMomentumClass(15).severity).toBe('notable');
    expect(cosponsorMomentumClass(15).label).toContain('+15');
  });
});

describe('derived change classes route to existing subscriber keys', () => {
  it('fiscal → fiscalNote, text → amendment, hearing → hearing, new-match → newMatch', () => {
    expect(FISCAL_NOTE_CLASS.triggerKey).toBe('fiscalNote');
    expect(TEXT_CHANGED_CLASS.triggerKey).toBe('amendment');
    expect(HEARING_SCHEDULED_CLASS.triggerKey).toBe('hearing');
    expect(NEW_MATCH_CLASS.triggerKey).toBe('newMatch');
  });
});

describe('parseTally (B4)', () => {
  it('reads the tally from committee/floor vote action text', () => {
    expect(parseTally('Ordered to be Reported by the Yeas and Nays: 44 - 12.')).toEqual({
      yeas: 44,
      nays: 12,
    });
    expect(parseTally('On passage Passed by recorded vote: 219 - 210.')).toEqual({
      yeas: 219,
      nays: 210,
    });
    expect(parseTally('Failed by the Yeas and Nays: 198 - 224.')).toEqual({ yeas: 198, nays: 224 });
    expect(parseTally('Agreed to by the Yeas and Nays: (2/3 required): 415 - 12.')).toEqual({
      yeas: 415,
      nays: 12,
    });
  });
  it('does not mistake a non-vote number span or a date for a tally', () => {
    expect(parseTally('Referred to the Committee on Armed Services.')).toBeNull();
    expect(parseTally('Introduced 2026-01-05; 12 cosponsors added.')).toBeNull();
    expect(parseTally(null)).toBeNull();
  });
});

describe('dedupeByChangeType', () => {
  const ev = (changeType: string): MaterialEvent => ({
    cls: { changeType, triggerKey: 'x', label: changeType, tone: 'info', severity: 'info' },
    text: '',
    date: null,
  });
  it('keeps the first event per changeType, order preserved (derived wins)', () => {
    const out = dedupeByChangeType([
      ev('bill_rule_failed'),
      ev('bill_amendment'),
      ev('bill_rule_failed'),
    ]);
    expect(out.map((e) => e.cls.changeType)).toEqual(['bill_rule_failed', 'bill_amendment']);
  });
});
