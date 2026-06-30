import {
  classifyChange,
  selectMaterialEvents,
  type ActionLike,
} from './tracker-change-detector.service.js';

const d = (s: string) => new Date(s);

describe('classifyChange', () => {
  it('classifies enactment / president / failure as critical', () => {
    expect(classifyChange('Became Public Law No: 119-42.')?.severity).toBe('critical');
    expect(classifyChange('Presented to President.')?.changeType).toBe('bill_to_president');
    expect(classifyChange('Failed of passage in Senate.')?.changeType).toBe('bill_failed');
  });
  it('classifies floor / committee / amendment as notable', () => {
    expect(classifyChange('Passed/agreed to in House')?.triggerKey).toBe('floorVote');
    expect(classifyChange('Ordered to be Reported')?.triggerKey).toBe('committeeVote');
    expect(classifyChange('House Amendment offered')?.triggerKey).toBe('amendment');
  });
  it('classifies hearings as info', () => {
    expect(classifyChange('Subcommittee Hearing Held.')?.severity).toBe('info');
  });
  it('classifies House Rules Committee activity as a floor-scheduled rule', () => {
    const a = classifyChange(
      'Rules Committee Resolution H. Res. 1234 Reported to House. Rule provides for consideration of H.R. 5009.',
    );
    expect(a?.changeType).toBe('bill_rule_reported');
    expect(a?.triggerKey).toBe('floorVote');
    expect(a?.severity).toBe('notable');
    expect(classifyChange('Considered under the provisions of H. Res. 1234.')?.changeType).toBe(
      'bill_rule_reported',
    );
    expect(
      classifyChange('Pursuant to the provisions of H. Res. 1234, the House resolved.')?.changeType,
    ).toBe('bill_rule_reported');
  });
  it('does not mislabel a committee-of-jurisdiction report or a combined passage', () => {
    // A real committee report (not Rules) stays a committee report.
    expect(
      classifyChange('Reported to House by the Committee on Armed Services. H. Rept. 119-100.')
        ?.changeType,
    ).toBe('bill_reported');
    // Floor passage wins even when the action also cites the rule.
    expect(
      classifyChange('Considered under the provisions of H. Res. 1234. Passed/agreed to in House.')
        ?.changeType,
    ).toBe('bill_passed_chamber');
  });
  it('returns null for routine procedural churn', () => {
    expect(classifyChange('Introduced in House.')).toBeNull();
    expect(classifyChange('Referred to the Committee on Armed Services.')).toBeNull();
    expect(classifyChange('Motion to reconsider laid on the table Agreed to.')).toBeNull();
    expect(classifyChange('')).toBeNull();
    expect(classifyChange(null)).toBeNull();
  });
});

describe('selectMaterialEvents', () => {
  it('returns one event per distinct changeType, chronological', () => {
    const actions: ActionLike[] = [
      { date: d('2026-06-10'), text: 'Subcommittee Hearing Held.' },
      { date: d('2026-06-15'), text: 'Ordered to be Reported by the Yeas and Nays.' },
      { date: d('2026-06-20'), text: 'Passed/agreed to in House.' },
    ];
    const events = selectMaterialEvents(actions, {
      date: d('2026-06-20'),
      text: 'Passed/agreed to in House.',
    });
    expect(events.map((e) => e.cls.triggerKey)).toEqual(['hearing', 'committeeVote', 'floorVote']);
  });

  it('de-dupes repeated changeTypes (keeps the earliest)', () => {
    const actions: ActionLike[] = [
      { date: d('2026-06-10'), text: 'House Amendment offered by Mr. A.' },
      { date: d('2026-06-11'), text: 'House Amendment offered by Mr. B.' },
    ];
    const events = selectMaterialEvents(actions, null);
    expect(events).toHaveLength(1);
    expect(events[0]?.cls.triggerKey).toBe('amendment');
    expect(events[0]?.text).toContain('Mr. A');
  });

  it('skips routine actions, keeps only material ones', () => {
    const actions: ActionLike[] = [
      { date: d('2026-06-10'), text: 'Introduced in House.' },
      { date: d('2026-06-12'), text: 'Referred to committee.' },
      { date: d('2026-06-14'), text: 'Passed the House.' },
    ];
    const events = selectMaterialEvents(actions, null);
    expect(events).toHaveLength(1);
    expect(events[0]?.cls.triggerKey).toBe('floorVote');
  });

  it('merges the rollup latest action even when not in the action rows (no regression)', () => {
    const events = selectMaterialEvents([], {
      date: d('2026-06-20'),
      text: 'Became Public Law No: 119-1.',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.cls.changeType).toBe('bill_enacted');
  });

  it('does not duplicate the latest action when it is already an action row', () => {
    const actions: ActionLike[] = [{ date: d('2026-06-20'), text: 'Passed the House.' }];
    const events = selectMaterialEvents(actions, {
      date: d('2026-06-20'),
      text: 'Passed the House.',
    });
    expect(events).toHaveLength(1);
  });

  it('returns nothing when there is no material move', () => {
    expect(selectMaterialEvents([{ date: d('2026-06-10'), text: 'Introduced.' }], null)).toEqual(
      [],
    );
  });
});
