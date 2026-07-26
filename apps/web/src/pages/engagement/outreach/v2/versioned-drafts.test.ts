// Outreach v2 — Phase 0 versioned-draft client rules (plan §5.4).
//
// The behaviours this file pins are the client half of the trust boundary:
//   • a local edit is IMMEDIATELY non-sendable (dirty), and only a returned
//     audited server version restores sendability;
//   • pending / held / unavailable / rejected are all excluded;
//   • held content is preserved, never replaced by a failure placeholder;
//   • a 409 edit conflict does not overwrite the latest content;
//   • navigation to Send is blocked until every draft settles.

import { describe, expect, it } from 'vitest';
import {
  DRAFT_BLOCK_COPY,
  applyNewVersion,
  applyVersionConflict,
  applyVersionedResult,
  canEnterSendStep,
  dirtyGenKeys,
  draftBlockReason,
  isDraftSendable,
  isVersioned,
  markDirty,
  partitionVersionedResults,
  readyCount,
  unsettledGenKeys,
  type DraftVersionRef,
  type VersionedBatchResult,
} from './versioned-drafts.js';
import type { GeneratedDraft } from './types.js';

/** Identity renderer — the markdown→HTML step is tested in richtext.test.ts. */
const raw = (s: string) => s;

const audited = (over: Partial<GeneratedDraft> = {}): GeneratedDraft => ({
  subject: 'S',
  body: 'B',
  versionId: 'v-1',
  artifactId: 'art-1',
  version: 1,
  generationStatus: 'generated',
  auditStatus: 'passed',
  approvalStatus: 'not_required',
  sendable: true,
  dirty: false,
  ...over,
});

describe('isDraftSendable — the client send gate', () => {
  it('an audited, clean version is sendable', () => {
    expect(isDraftSendable(audited())).toBe(true);
  });

  it('a LOCAL EDIT is immediately NOT sendable', () => {
    const edited = markDirty(audited(), { body: 'B changed' });
    expect(edited.dirty).toBe(true);
    expect(isDraftSendable(edited)).toBe(false);
    // Even though the server previously said sendable:true.
    expect(audited().sendable).toBe(true);
  });

  it('dirty beats a stale server sendable:true flag', () => {
    expect(isDraftSendable({ ...audited(), dirty: true, sendable: true })).toBe(false);
  });

  it('pending / held / unavailable versions are excluded', () => {
    for (const auditStatus of ['pending', 'held', 'unavailable'] as const) {
      expect(isDraftSendable(audited({ auditStatus, sendable: false }))).toBe(false);
    }
  });

  it('a rejected version is excluded, and an approval alone cannot release a hold', () => {
    expect(isDraftSendable(audited({ approvalStatus: 'rejected', sendable: false }))).toBe(false);
    // held + approved is deliberately NOT sendable: approval must also clear the
    // audit hold on that same row (which the server does).
    expect(
      isDraftSendable(audited({ auditStatus: 'held', approvalStatus: 'approved', sendable: false })),
    ).toBe(false);
    expect(isDraftSendable(audited({ auditStatus: 'passed', approvalStatus: 'approved' }))).toBe(
      true,
    );
  });

  it('recomputes the policy when the server omits `sendable` (fails closed)', () => {
    const noFlag = { ...audited(), sendable: undefined };
    expect(isDraftSendable({ ...noFlag, auditStatus: 'passed' })).toBe(true);
    expect(isDraftSendable({ ...noFlag, auditStatus: 'held' })).toBe(false);
    expect(isDraftSendable({ ...noFlag, approvalStatus: 'pending' })).toBe(false);
  });

  it('an undefined draft is never sendable', () => {
    expect(isDraftSendable(undefined)).toBe(false);
  });

  it('LEGACY (flag-off) drafts still use the old status vocabulary', () => {
    expect(isVersioned({ subject: 'S', body: 'B', status: 'ready' })).toBe(false);
    expect(isDraftSendable({ subject: 'S', body: 'B', status: 'ready' })).toBe(true);
    expect(isDraftSendable({ subject: 'S', body: 'B', status: 'edited' })).toBe(true);
    expect(isDraftSendable({ subject: 'S', body: 'B', status: 'error' })).toBe(false);
  });
});

describe('draftBlockReason — the banner never mislabels a hold as a failure', () => {
  it('distinguishes every blocking state', () => {
    expect(draftBlockReason(audited())).toBeNull();
    expect(draftBlockReason(markDirty(audited(), { body: 'x' }))).toBe('dirty');
    expect(draftBlockReason(audited({ auditStatus: 'pending' }))).toBe('pending');
    expect(draftBlockReason(audited({ auditStatus: 'held' }))).toBe('held');
    expect(draftBlockReason(audited({ auditStatus: 'unavailable' }))).toBe('unavailable');
    expect(draftBlockReason(audited({ approvalStatus: 'rejected' }))).toBe('rejected');
    expect(draftBlockReason(audited({ approvalStatus: 'pending' }))).toBe('awaiting_review');
    expect(draftBlockReason(audited({ generationStatus: 'generation_failed' }))).toBe(
      'generation_failed',
    );
    expect(draftBlockReason(undefined)).toBe('missing');
  });

  it('held copy talks about REVIEW, not generation failure', () => {
    expect(DRAFT_BLOCK_COPY.held).toMatch(/review/i);
    expect(DRAFT_BLOCK_COPY.held).not.toMatch(/failed/i);
    expect(DRAFT_BLOCK_COPY.unavailable).toMatch(/unavailable/i);
    expect(DRAFT_BLOCK_COPY.unavailable).not.toMatch(/failed/i);
  });
});

describe('applyVersionedResult — held content is preserved', () => {
  const heldRef: DraftVersionRef = {
    generationKey: 'individual:a@x.com',
    artifactId: 'art-1',
    versionId: 'v-1',
    version: 1,
    generationStatus: 'generated',
    auditStatus: 'held',
    approvalStatus: 'pending',
    reviewRequestId: 'rr-1',
    sendable: false,
  };

  it('keeps the real held subject/body and attaches the review link', () => {
    const result: VersionedBatchResult = {
      recipientId: 'a@x.com',
      subject: 'Funding update',
      body: 'H.R.1 was signed into law.',
      status: 'held',
      contextNote: 'Unverified — 1 grounding finding',
      versions: [heldRef],
    };
    const draft = applyVersionedResult(undefined, result, heldRef, raw);
    // The content is NOT a placeholder.
    expect(draft.subject).toBe('Funding update');
    expect(draft.body).toBe('H.R.1 was signed into law.');
    expect(draft.body).not.toMatch(/placeholder/i);
    expect(draft.reviewRequestId).toBe('rr-1');
    expect(draft.contextNote).toMatch(/Unverified/);
    // …and it is still not sendable.
    expect(isDraftSendable(draft)).toBe(false);
  });

  it('a genuine generation failure yields no version and is not sendable', () => {
    const result: VersionedBatchResult = {
      recipientId: 'a@x.com',
      subject: '',
      body: '',
      status: 'error',
      generationStatus: 'generation_failed',
      artifactId: 'art-9',
    };
    const draft = applyVersionedResult(undefined, result, undefined, raw);
    expect(draft.versionId).toBeUndefined();
    // The artifact id survives so the user can author a manual version.
    expect(draft.artifactId).toBe('art-9');
    expect(isDraftSendable(draft)).toBe(false);
  });
});

describe('partitionVersionedResults', () => {
  const slots = [
    { genKey: 'individual:a', resultId: 'a' },
    { genKey: 'individual:b', resultId: 'b' },
  ];

  it('matches slots by generationKey, so one draft can back several slots', () => {
    // The same recipient backs two list slots and is generated ONCE.
    const shared: VersionedBatchResult = {
      recipientId: 'a',
      subject: 'S',
      body: 'B',
      status: 'ready',
      versions: [
        {
          generationKey: 'list:l1:a',
          artifactId: 'art-1',
          versionId: 'v-1',
          version: 1,
          auditStatus: 'passed',
          approvalStatus: 'not_required',
          sendable: true,
        },
        {
          generationKey: 'list:l2:a',
          artifactId: 'art-2',
          versionId: 'v-2',
          version: 1,
          auditStatus: 'passed',
          approvalStatus: 'not_required',
          sendable: true,
        },
      ],
    };
    const { patches } = partitionVersionedResults(
      [
        { genKey: 'list:l1:a', resultId: 'a' },
        { genKey: 'list:l2:a', resultId: 'a' },
      ],
      [shared],
      raw,
    );
    expect(patches.map((p) => p.draft.versionId)).toEqual(['v-1', 'v-2']);
  });

  it('separates held from failed', () => {
    const { patches, failedGenKeys, heldGenKeys } = partitionVersionedResults(
      slots,
      [
        {
          recipientId: 'a',
          subject: 'SA',
          body: 'BA',
          status: 'held',
          versions: [
            {
              generationKey: 'individual:a',
              artifactId: 'art-1',
              versionId: 'v-1',
              version: 1,
              auditStatus: 'held',
              approvalStatus: 'pending',
              sendable: false,
            },
          ],
        },
        {
          recipientId: 'b',
          subject: '',
          body: '',
          status: 'error',
          generationStatus: 'generation_failed',
        },
      ],
      raw,
    );
    expect(heldGenKeys).toEqual(['individual:a']);
    expect(failedGenKeys).toEqual(['individual:b']);
    // The held draft kept its content.
    expect(patches.find((p) => p.genKey === 'individual:a')!.draft.body).toBe('BA');
  });

  it('a dropped slot is a failure', () => {
    const { failedGenKeys } = partitionVersionedResults(slots, [], raw);
    expect(failedGenKeys.sort()).toEqual(['individual:a', 'individual:b']);
  });
});

describe('applyNewVersion — only a server version restores sendability', () => {
  it('clears dirty and adopts the returned lifecycle', () => {
    const dirty = markDirty(audited(), { body: 'edited text' });
    expect(isDraftSendable(dirty)).toBe(false);
    const saved = applyNewVersion(dirty, {
      id: 'v-2',
      artifactId: 'art-1',
      version: 2,
      subject: 'S',
      body: 'edited text',
      generationStatus: 'manually_authored',
      auditStatus: 'passed',
      approvalStatus: 'not_required',
      sendable: true,
    });
    expect(saved.dirty).toBe(false);
    expect(saved.versionId).toBe('v-2');
    expect(isDraftSendable(saved)).toBe(true);
  });

  it('a new version that is HELD stays unsendable even after saving', () => {
    const dirty = markDirty(audited(), { body: 'newly contradicting text' });
    const saved = applyNewVersion(dirty, {
      id: 'v-2',
      artifactId: 'art-1',
      version: 2,
      subject: 'S',
      body: 'newly contradicting text',
      generationStatus: 'manually_authored',
      auditStatus: 'held',
      approvalStatus: 'pending',
      reviewRequestId: 'rr-2',
      sendable: false,
    });
    expect(isDraftSendable(saved)).toBe(false);
    expect(saved.reviewRequestId).toBe('rr-2');
  });
});

describe('applyVersionConflict — a 409 never overwrites the latest content', () => {
  it('keeps the local text, stays dirty, and flags a conflict', () => {
    const dirty = markDirty(audited(), { body: 'my local text' });
    const conflicted = applyVersionConflict(dirty, { currentVersionId: 'v-9' });
    // The user's work is not discarded…
    expect(conflicted.body).toBe('my local text');
    // …but it is unsaved, unsendable, and marked so the UI can offer "Load latest".
    expect(conflicted.dirty).toBe(true);
    expect(conflicted.sendable).toBe(false);
    expect(conflicted.localStatus).toBe('conflict');
    expect(isDraftSendable(conflicted)).toBe(false);
    // Crucially, the winning version's content is NOT written into local state.
    expect(conflicted.body).not.toContain('v-9');
  });
});

describe('navigation gating into Send', () => {
  const slots = [{ genKey: 'a' }, { genKey: 'b' }];

  it('blocks while ANY draft is dirty, and reports which', () => {
    const gate = canEnterSendStep(slots, {
      a: audited(),
      b: markDirty(audited(), { body: 'typing' }),
    });
    expect(gate.ok).toBe(false);
    expect(gate.dirty).toEqual(['b']);
    expect(dirtyGenKeys(slots, { a: audited(), b: markDirty(audited(), { body: 'x' }) })).toEqual([
      'b',
    ]);
  });

  it('blocks on held / pending / unavailable / rejected', () => {
    for (const over of [
      { auditStatus: 'held' as const },
      { auditStatus: 'pending' as const },
      { auditStatus: 'unavailable' as const },
      { approvalStatus: 'rejected' as const },
    ]) {
      const gate = canEnterSendStep(slots, {
        a: audited(),
        b: audited({ ...over, sendable: false }),
      });
      expect(gate.ok).toBe(false);
      expect(gate.blocked).toEqual(['b']);
    }
  });

  it('allows only when every draft is a cleared server version', () => {
    const gate = canEnterSendStep(slots, { a: audited(), b: audited({ versionId: 'v-2' }) });
    expect(gate.ok).toBe(true);
    expect(gate.blocked).toEqual([]);
    expect(unsettledGenKeys(slots, { a: audited(), b: audited({ versionId: 'v-2' }) })).toEqual([]);
  });

  it('a missing draft blocks navigation', () => {
    expect(canEnterSendStep(slots, { a: audited() }).ok).toBe(false);
  });

  it('readyCount counts only cleared versions', () => {
    expect(
      readyCount(slots, { a: audited(), b: audited({ auditStatus: 'held', sendable: false }) }),
    ).toBe(1);
  });
});
