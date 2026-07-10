import {
  classifyChange,
  classifyStatusChange,
  classifyStateStatusChange,
  stateVoteRecordedClass,
  STATE_COMPANION_MOVED_CLASS,
  cosponsorMomentumClass,
} from './change-detector.util.js';

describe('classifyStateStatusChange (State Legislation Platform S4.3)', () => {
  it('maps the 5 terminal statuses to enactedFailed', () => {
    for (const s of ['enacted', 'vetoed', 'failed', 'dead_by_deadline']) {
      const cls = classifyStateStatusChange(s);
      expect(cls?.changeType).toBe(`state_bill_${s}`);
      expect(cls?.triggerKey).toBe('enactedFailed');
    }
  });
  it('maps passed_chamber/floor/to_governor/veto_overridden/resolving to floorVote', () => {
    for (const s of ['passed_chamber', 'floor', 'to_governor', 'veto_overridden', 'resolving']) {
      expect(classifyStateStatusChange(s)?.triggerKey).toBe('floorVote');
    }
  });
  it('maps reported to committeeVote', () => {
    expect(classifyStateStatusChange('reported')?.triggerKey).toBe('committeeVote');
  });
  it('returns null for committee/introduced (routine, not alert-worthy) and unknown/null', () => {
    expect(classifyStateStatusChange('committee')).toBeNull();
    expect(classifyStateStatusChange('introduced')).toBeNull();
    expect(classifyStateStatusChange(null)).toBeNull();
    expect(classifyStateStatusChange('bogus')).toBeNull();
  });
  it('label comes from the shared stateBillStatusLabel (single source of truth)', () => {
    expect(classifyStateStatusChange('dead_by_deadline')?.label).toMatch(/dead|sine die/i);
  });
});

describe('stateVoteRecordedClass', () => {
  it('routes a final-passage motion to floorVote', () => {
    expect(stateVoteRecordedClass(true).triggerKey).toBe('floorVote');
    expect(stateVoteRecordedClass(true).changeType).toBe('state_bill_vote_recorded');
  });
  it('routes a non-final-passage (committee-level) motion to committeeVote', () => {
    expect(stateVoteRecordedClass(false).triggerKey).toBe('committeeVote');
  });
});

describe('STATE_COMPANION_MOVED_CLASS', () => {
  it('is the first-ever emitter for the companion trigger key', () => {
    expect(STATE_COMPANION_MOVED_CLASS.triggerKey).toBe('companion');
    expect(STATE_COMPANION_MOVED_CLASS.changeType).toBe('state_companion_moved');
  });
});

describe('cross-rail reuse — state events lean on federal factories unmodified', () => {
  it('cosponsorMomentumClass is rail-agnostic (no congress-specific naming)', () => {
    const cls = cosponsorMomentumClass(7);
    expect(cls.changeType).toBe('bill_cosponsor_momentum');
    expect(cls.triggerKey).toBe('sponsorMomentum');
  });
  it('classifyChange/classifyStatusChange remain byte-identical (Phase-5 parity gate) — untouched by the state additions', () => {
    expect(classifyChange('Became Public Law No: 119-42.')?.changeType).toBe('bill_enacted');
    expect(classifyStatusChange('rule_failed')?.changeType).toBe('bill_rule_failed');
    expect(classifyStatusChange('committee')).toBeNull();
  });
});
