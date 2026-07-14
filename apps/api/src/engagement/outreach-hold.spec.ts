import {
  outreachDraftHoldKey,
  OUTREACH_HOLD_BLOCKING_STATUSES,
  OUTREACH_HOLD_SUBJECT_TYPE,
} from './outreach-hold.js';

describe('outreach hold keys (§3.3 server-side send gate)', () => {
  it('is deterministic: same recipient+subject+body → same key across generate/send', () => {
    const a = outreachDraftHoldKey('rec-1', 'Subject', 'Body text');
    const b = outreachDraftHoldKey('rec-1', 'Subject', 'Body text');
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{40}$/);
  });

  it('changes when ANY component changes — an edited draft is new content', () => {
    const base = outreachDraftHoldKey('rec-1', 'Subject', 'Body');
    expect(outreachDraftHoldKey('rec-2', 'Subject', 'Body')).not.toBe(base);
    expect(outreachDraftHoldKey('rec-1', 'Subject!', 'Body')).not.toBe(base);
    expect(outreachDraftHoldKey('rec-1', 'Subject', 'Body.')).not.toBe(base);
  });

  it('field boundaries are unambiguous (subject/body cannot collide across the separator)', () => {
    // Without a separator these two would hash identically.
    expect(outreachDraftHoldKey('r', 'AB', 'C')).not.toBe(outreachDraftHoldKey('r', 'A', 'BC'));
  });

  it('blocks pending AND rejected; only approved releases', () => {
    expect(OUTREACH_HOLD_BLOCKING_STATUSES).toContain('pending');
    expect(OUTREACH_HOLD_BLOCKING_STATUSES).toContain('rejected');
    expect(OUTREACH_HOLD_BLOCKING_STATUSES).not.toContain('approved' as never);
    expect(OUTREACH_HOLD_SUBJECT_TYPE).toBe('outreach-draft');
  });
});
