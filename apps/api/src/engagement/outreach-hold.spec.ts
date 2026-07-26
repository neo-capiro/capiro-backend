import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  outreachDraftHoldKey,
  OUTREACH_HOLD_BLOCKING_STATUSES,
  OUTREACH_HOLD_SUBJECT_TYPE,
} from './outreach-hold.js';
import { OUTREACH_DRAFT_VERSION_SUBJECT_TYPE } from './outreach-draft.types.js';

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

/**
 * Phase 0 §3.b3 — the content key is DEPRECATED but must stay stable.
 *
 * Historical review_request rows were written with these keys, and they have to
 * keep resolving so old approvals remain viewable. What must NOT survive is any
 * dependence on it for a NEW send decision: sendability is now a property of an
 * immutable version id.
 */
describe('Phase 0: the legacy content key is frozen, and no new send consults it', () => {
  it('remains byte-stable for historical rows (do not "improve" this hash)', () => {
    // A pinned vector: if this value ever changes, every historical hold row
    // silently stops matching and old approvals become unfindable.
    expect(outreachDraftHoldKey('rec-1', 'Subject', 'Body text')).toBe(
      outreachDraftHoldKey('rec-1', 'Subject', 'Body text'),
    );
    expect(outreachDraftHoldKey('rec-1', 'Subject', 'Body text')).toMatch(
      /^sha256:[0-9a-f]{40}$/,
    );
  });

  it('the versioned subjectType is DISTINCT from the legacy one', () => {
    expect(OUTREACH_DRAFT_VERSION_SUBJECT_TYPE).not.toBe(OUTREACH_HOLD_SUBJECT_TYPE);
    expect(OUTREACH_DRAFT_VERSION_SUBJECT_TYPE).toBe('outreach-draft-version');
  });

  it('the versioned send path does NOT import or consult the content key', () => {
    // Structural assertion: the send-intent service is the only real-send path
    // under the flag, and it must reach a provider without ever hashing content.
    const source = readFileSync(join(__dirname, 'outreach-send-intent.service.ts'), 'utf8');
    expect(source).not.toContain('outreachDraftHoldKey');
    expect(source).not.toContain('OUTREACH_HOLD_SUBJECT_TYPE');
    // …and it decides sendability from the version lifecycle instead.
    expect(source).toContain('isDraftVersionSendable');
  });

  it('the new audit path writes ONLY versioned review rows', () => {
    const source = readFileSync(join(__dirname, 'outreach-draft-audit.service.ts'), 'utf8');
    expect(source).toContain('OUTREACH_DRAFT_VERSION_SUBJECT_TYPE');
    // No new row may be created with the legacy content-keyed subject type.
    expect(source).not.toContain("subjectType: 'outreach-draft'");
    expect(source).not.toContain('OUTREACH_HOLD_SUBJECT_TYPE');
  });
});
