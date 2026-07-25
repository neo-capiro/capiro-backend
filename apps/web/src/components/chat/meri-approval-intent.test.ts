import { describe, expect, it } from 'vitest';
import { detectApprovalIntent, osaDistance } from './meri-approval-intent.js';

describe('osaDistance', () => {
  it('treats an adjacent transposition as a single edit', () => {
    // The real miss: "i apporve all of it" never approved anything.
    expect(osaDistance('apporve', 'approve', 1)).toBe(1);
  });

  it('keeps genuinely different words apart', () => {
    // "improve" is 2 substitutions from "approve" — a different instruction.
    expect(osaDistance('improve', 'approve', 1)).toBeGreaterThan(1);
  });

  it('is zero for an exact match and bails out early on length gaps', () => {
    expect(osaDistance('approve', 'approve', 1)).toBe(0);
    expect(osaDistance('a', 'approve', 1)).toBeGreaterThan(1);
  });
});

describe('detectApprovalIntent', () => {
  it('accepts the plain approvals', () => {
    for (const s of ['approve', 'I approve', 'approved', 'go ahead', 'do it', 'run it', 'lgtm']) {
      expect(detectApprovalIntent(s).approved, s).toBe(true);
    }
  });

  it('accepts the typo that started all this', () => {
    const intent = detectApprovalIntent('i apporve all of it');
    expect(intent.approved).toBe(true);
    expect(intent.all).toBe(true);
  });

  it('flags "all" only when the user actually said so', () => {
    expect(detectApprovalIntent('approve all').all).toBe(true);
    expect(detectApprovalIntent('approve everything').all).toBe(true);
    expect(detectApprovalIntent('i approve').all).toBe(false);
  });

  it('rejects bare affirmatives — they usually answer Meri’s last question', () => {
    for (const s of ['yes', 'ok', 'okay', 'sure', 'yep', 'y']) {
      expect(detectApprovalIntent(s).approved, s).toBe(false);
    }
  });

  it('rejects negations and hedges even when an approval word is present', () => {
    for (const s of [
      "don't approve that",
      'do not approve',
      'approve everything except the last one',
      'why do I need to approve?',
      'should I approve this',
      'no, approve later',
    ]) {
      expect(detectApprovalIntent(s).approved, s).toBe(false);
    }
  });

  it('rejects prose that merely mentions approval', () => {
    const prose =
      'I approve of how you structured the memo but please rewrite section three before sending';
    expect(detectApprovalIntent(prose).approved).toBe(false);
  });

  it('rejects unrelated instructions and empty input', () => {
    expect(detectApprovalIntent('improve the description').approved).toBe(false);
    expect(detectApprovalIntent('add more detail to the profile').approved).toBe(false);
    expect(detectApprovalIntent('').approved).toBe(false);
    expect(detectApprovalIntent('   ').approved).toBe(false);
  });
});
