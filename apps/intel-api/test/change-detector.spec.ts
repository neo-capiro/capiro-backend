import {
  classifyChange,
  selectMaterialEvents,
  severityToMateriality,
  type ActionLike,
} from '../src/tracker/change-detector.util.js';

/** Phase 3 (plan §6.3): classifyChange cascade parity with legacy. */
describe('classifyChange', () => {
  const cases: Array<[string, string, string, string]> = [
    ['Became Public Law No. 118-1', 'bill_enacted', 'critical', 'enactedFailed'],
    ['Presented to President.', 'bill_to_president', 'critical', 'enactedFailed'],
    ['Motion to table agreed to', 'bill_failed', 'critical', 'enactedFailed'],
    ['Passed/agreed to in House', 'bill_passed_chamber', 'notable', 'floorVote'],
    ['Rules Committee Resolution H. Res. 5 provides for consideration', 'bill_rule_reported', 'notable', 'floorVote'],
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
    expect(evs.map((e) => e.cls.changeType)).toEqual(['bill_reported', 'bill_markup', 'bill_passed_chamber']);
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
