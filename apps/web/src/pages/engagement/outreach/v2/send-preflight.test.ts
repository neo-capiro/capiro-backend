// Phase 2 §3.h1 — send preflight composes existing per-concern checks into
// one blockers/warnings list. The only new rule here is the mandatory final
// review checkbox; everything else delegates to already-tested primitives
// (isDraftSendable, attachmentPreflight, collisionsResolved).

import { describe, expect, it } from 'vitest';
import { computeSendPreflight, type SendPreflightInput } from './send-preflight.js';
import {
  analyzeRecipientCollisions,
  collisionsFingerprint,
  type OutreachTarget,
} from './targets.js';
import type { OutreachRecipient } from '../../OutreachView.js';
import type { GeneratedDraft } from './types.js';

const rec = (email: string): OutreachRecipient => ({ email });
const individual = (email: string): OutreachTarget => ({
  key: `t-${email}`,
  type: 'individual',
  recipients: [rec(email)],
  cc: [],
  bcc: [],
});

function sendableDraft(): GeneratedDraft {
  return {
    subject: 'S',
    body: 'B',
    artifactId: 'art-1',
    versionId: 'v-1',
    version: 1,
    generationStatus: 'generated',
    auditStatus: 'passed',
    approvalStatus: 'not_required',
    sendable: true,
    dirty: false,
  };
}

const baseInput: SendPreflightInput = {
  targets: [individual('a@x.com')],
  slots: [{ genKey: 'individual:a@x.com', resultId: 'a@x.com' }],
  generated: { 'individual:a@x.com': sendableDraft() },
  attachmentIds: [],
  docs: [],
  collisionResolution: null,
  emailConnected: true,
  selectedInboxId: 'inbox-1',
};

describe('computeSendPreflight', () => {
  it.each(['dirty', 'pending'] as const)(
    'blocks a partial send while one of two drafts is %s',
    (state) => {
      const result = computeSendPreflight({
        ...baseInput,
        targets: [individual('a@x.com'), individual('b@x.com')],
        slots: [...baseInput.slots, { genKey: 'individual:b@x.com', resultId: 'b@x.com' }],
        generated: {
          ...baseInput.generated,
          'individual:b@x.com': {
            ...sendableDraft(),
            ...(state === 'dirty' ? { dirty: true } : { auditStatus: 'pending', sendable: false }),
          },
        },
      });
      expect(result.sendableCount).toBe(1);
      expect(result.canSend).toBe(false);
    },
  );

  it('blocks sending until every attachment upload completes', () => {
    const pending = computeSendPreflight({ ...baseInput, attachmentUploadsPending: 2 });
    expect(pending.canSend).toBe(false);
    expect(pending.blockers[0]!.message).toMatch(/uploads to finish/);
    expect(computeSendPreflight({ ...baseInput, attachmentUploadsPending: 0 }).canSend).toBe(true);
  });

  it('blocks sending after an upload failure until the failed file is removed or retried', () => {
    const result = computeSendPreflight({ ...baseInput, attachmentUploadFailures: ['brief.pdf'] });
    expect(result.canSend).toBe(false);
    expect(result.blockers[0]!.message).toContain('brief.pdf');
  });
  it('allows send when everything is clean', () => {
    const result = computeSendPreflight(baseInput);
    expect(result.canSend).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.sendableCount).toBe(1);
  });

  it('blocks when no email account is connected', () => {
    const result = computeSendPreflight({ ...baseInput, emailConnected: false });
    expect(result.canSend).toBe(false);
    expect(result.blockers.some((b) => b.category === 'mailbox')).toBe(true);
  });

  it('blocks when no sender inbox is selected', () => {
    const result = computeSendPreflight({ ...baseInput, selectedInboxId: null });
    expect(result.canSend).toBe(false);
    expect(result.blockers.some((b) => b.category === 'mailbox')).toBe(true);
  });

  it('blocks on an unresolved recipient collision', () => {
    const targets: OutreachTarget[] = [
      individual('gail@x.com'),
      { key: 'G1', type: 'group', name: 'G', recipients: [rec('gail@x.com')], cc: [], bcc: [] },
    ];
    const result = computeSendPreflight({ ...baseInput, targets });
    expect(result.canSend).toBe(false);
    expect(result.blockers.some((b) => b.category === 'recipients')).toBe(true);
  });

  it('does not block on a collision the user explicitly kept', () => {
    const targets: OutreachTarget[] = [
      individual('gail@x.com'),
      { key: 'G1', type: 'group', name: 'G', recipients: [rec('gail@x.com')], cc: [], bcc: [] },
    ];
    // Fingerprint must match the CURRENT collision set — computed the same
    // way collisionsResolved does internally.
    const fingerprint = collisionsFingerprint(analyzeRecipientCollisions(targets));
    const result = computeSendPreflight({
      ...baseInput,
      targets,
      collisionResolution: { fingerprint, keepAllEmails: ['gail@x.com'] },
    });
    expect(result.canSend).toBe(true);
  });

  it('blocks on an oversized attachment', () => {
    const result = computeSendPreflight({
      ...baseInput,
      attachmentIds: ['doc-1'],
      docs: [{ id: 'doc-1', fileName: 'huge.pdf', byteSize: 10 * 1024 * 1024 }],
    });
    expect(result.canSend).toBe(false);
    expect(result.blockers.some((b) => b.category === 'attachments')).toBe(true);
  });

  it('blocks with zero sendable drafts', () => {
    const result = computeSendPreflight({ ...baseInput, generated: {} });
    expect(result.canSend).toBe(false);
    expect(result.sendableCount).toBe(0);
    expect(result.blockedGenKeys).toEqual(['individual:a@x.com']);
  });

  it('treats a held draft as a blocker, distinct from a merely dirty (unsaved) one', () => {
    const held = computeSendPreflight({
      ...baseInput,
      generated: {
        'individual:a@x.com': { ...sendableDraft(), sendable: false, auditStatus: 'held' },
      },
    });
    expect(held.blockers.some((b) => b.category === 'verification')).toBe(true);

    const dirty = computeSendPreflight({
      ...baseInput,
      generated: { 'individual:a@x.com': { ...sendableDraft(), dirty: true, sendable: false } },
    });
    // dirty is a WARNING category-wise in spirit (transient/autosaving), but
    // since it's also not sendable, sendableCount hits zero and that itself
    // is a hard blocker — dirty never quietly lets a Send through.
    expect(dirty.canSend).toBe(false);
  });

  it('blocks a critical source failure via the shared draftBlockReason path', () => {
    const result = computeSendPreflight({
      ...baseInput,
      generated: {
        'individual:a@x.com': {
          ...sendableDraft(),
          sendable: false,
          manifest: { criticalFailures: [{ code: 'x', message: 'missing bill' }] },
        } as unknown as GeneratedDraft,
      },
    });
    expect(result.canSend).toBe(false);
    expect(
      result.blockers.some((b) => b.message.toLowerCase().includes('context could not be loaded')),
    ).toBe(true);
  });

  it('blocks while a send is already in flight (idempotency)', () => {
    const result = computeSendPreflight({ ...baseInput, sendInFlight: true });
    expect(result.canSend).toBe(false);
    expect(result.blockers.some((b) => b.category === 'idempotency')).toBe(true);
  });
});
