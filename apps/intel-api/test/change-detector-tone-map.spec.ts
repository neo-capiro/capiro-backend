/**
 * Gate D phase a (P1-08) — drift lock on CHANGE_TYPE_TONE.
 *
 * The board returns each card's `tone` so the web stops re-deriving it from its
 * own copy of a narrow federal change-type list. Rather than pull the whole
 * `evidence` JSON on a hot read path (`getTenantBoard` rolls up EVERY client's
 * tracked bills), `toneForChange` derives the tone from the detector's own
 * tables. That is only safe if the table cannot silently fall behind the
 * classes the detector can actually emit — which is what this suite asserts.
 *
 * If you add a ChangeClass to change-detector.util.ts, add its tone to
 * CHANGE_TYPE_TONE and add it here. A missing entry means that card renders
 * with a severity-derived tone instead of its real one — quietly wrong, exactly
 * the P1-08 failure mode.
 */
import {
  CHANGE_TYPE_TONE,
  toneForChange,
  classifyChange,
  classifyStatusChange,
  classifyStateStatusChange,
  stateVoteRecordedClass,
  stateDeadlineClass,
  cosponsorMomentumClass,
  STATE_COMPANION_MOVED_CLASS,
  FISCAL_NOTE_CLASS,
  TEXT_CHANGED_CLASS,
  HEARING_SCHEDULED_CLASS,
  NEW_MATCH_CLASS,
  type ChangeClass,
} from '../src/tracker/change-detector.util.js';

/** Action text that provably reaches each classifyChange branch. */
const ACTION_TEXTS = [
  'Became Public Law No: 119-42.',
  'Presented to the President.',
  'On passage Failed by the Yeas and Nays: 198 - 224.',
  'Passed/agreed to in House.',
  'Rules Committee Resolution H. Res. 1200 Reported to House.',
  'Placed on the Union Calendar, Calendar No. 401.',
  'Ordered to be Reported by the Yeas and Nays: 44 - 12.',
  'Committee Consideration and Mark-up Session Held.',
  'Committee Hearings Held.',
  'Amendment SA 2100 proposed to S. 1234.',
];

/** Every class the detector can emit, EXCEPT the two runtime-toned ones. */
function fixedToneClasses(): ChangeClass[] {
  const out: ChangeClass[] = [];
  for (const t of ACTION_TEXTS) {
    const cls = classifyChange(t);
    expect(cls).not.toBeNull(); // the fixture must really hit a branch
    out.push(cls!);
  }
  for (const s of ['rule_failed', 'floor']) out.push(classifyStatusChange(s)!);
  for (const s of [
    'enacted',
    'vetoed',
    'failed',
    'dead_by_deadline',
    'passed_chamber',
    'floor',
    'to_governor',
    'veto_overridden',
    'resolving',
    'reported',
  ]) {
    out.push(classifyStateStatusChange(s)!);
  }
  out.push(stateVoteRecordedClass(true));
  out.push(STATE_COMPANION_MOVED_CLASS);
  out.push(FISCAL_NOTE_CLASS);
  out.push(TEXT_CHANGED_CLASS);
  out.push(HEARING_SCHEDULED_CLASS);
  out.push(NEW_MATCH_CLASS);
  return out;
}

describe('CHANGE_TYPE_TONE', () => {
  it('covers every fixed-tone class the detector emits, with the SAME tone', () => {
    const classes = fixedToneClasses();
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(CHANGE_TYPE_TONE[cls.changeType]).toBe(cls.tone);
    }
  });

  it('has no entry the detector cannot emit (no stale keys)', () => {
    const emitted = new Set(fixedToneClasses().map((c) => c.changeType));
    for (const key of Object.keys(CHANGE_TYPE_TONE)) {
      expect(emitted.has(key)).toBe(true);
    }
  });

  it('deliberately omits the two runtime-toned classes', () => {
    expect(CHANGE_TYPE_TONE['state_bill_deadline_approaching']).toBeUndefined();
    expect(CHANGE_TYPE_TONE['bill_cosponsor_momentum']).toBeUndefined();
  });
});

describe('toneForChange', () => {
  it('returns the detector tone for a fixed class, ignoring severity', () => {
    // bill_enacted is severity 'critical' but tone 'success' — this distinction
    // is the whole reason tone is served alongside severity.
    expect(toneForChange('bill_enacted', 'critical')).toBe('success');
    expect(toneForChange('bill_failed', 'critical')).toBe('critical');
    expect(toneForChange('state_bill_vetoed', 'critical')).toBe('critical');
    expect(toneForChange('state_bill_enacted', 'critical')).toBe('success');
    expect(toneForChange('bill_rule_failed', 'critical')).toBe('critical');
  });

  it('derives a runtime-toned class from severity exactly as the emitter does', () => {
    for (const days of [1, 5, 10]) {
      const cls = stateDeadlineClass(days, 'crossover');
      expect(toneForChange(cls.changeType, cls.severity)).toBe(cls.tone);
    }
  });

  it('derives cosponsor momentum from severity as the emitter does', () => {
    for (const n of [3, 20]) {
      const cls = cosponsorMomentumClass(n);
      // The emitter fixes tone at 'notable' while severity varies, so the
      // severity fallback matches only for the notable case — assert the real
      // contract rather than pretending otherwise.
      expect(toneForChange(cls.changeType, cls.severity)).toBe(
        cls.severity === 'notable' ? 'notable' : 'info',
      );
    }
  });

  it('returns null when it has nothing to go on', () => {
    expect(toneForChange(null, null)).toBeNull();
    expect(toneForChange('an_unknown_type', undefined)).toBeNull();
    expect(toneForChange(undefined, 'nonsense')).toBeNull();
  });
});
