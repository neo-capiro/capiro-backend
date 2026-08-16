import type { OutreachV3DraftVersionIdentity } from '../drafts/outreach-v3-draft-lifecycle.js';
import { createOutreachV3DraftApprovalSnapshot } from '../drafts/outreach-v3-draft-lifecycle.js';
import type {
  OutreachV3GenerationPlan,
  OutreachV3GenerationRecipient,
} from '../generation/outreach-v3-generation-plan.js';
import {
  evaluateOutreachV3Preflight,
  type OutreachV3PreflightDraft,
} from './outreach-v3-preflight.js';

function plan(shared = false): OutreachV3GenerationPlan {
  const slots = shared
    ? [
        {
          generationKey: 'slot-group',
          recipientKey: 'group',
          audienceKind: 'group' as const,
          scopeKeys: ['a', 'b'],
          recipients: [recipient('a', 'a@example.test'), recipient('b', 'b@example.test')],
          context: emptyContext(),
          diversitySignature: 'group',
        },
      ]
    : ['a', 'b'].map((key) => ({
        generationKey: `slot-${key}`,
        recipientKey: key,
        audienceKind: 'individual' as const,
        scopeKeys: [key],
        recipients: [recipient(key, `${key}@example.test`)],
        context: emptyContext(),
        diversitySignature: key,
      }));
  return {
    planVersion: 'outreach_v3_generation_plan_v1',
    planHash: 'a'.repeat(64),
    sessionId: '11111111-1111-4111-8111-111111111111',
    stateVersion: 10,
    specHash: 'b'.repeat(64),
    eligible: true,
    blockers: [],
    sponsorClientId: null,
    deliveryPattern: shared ? 'shared_thread' : 'personalized_separate',
    personalization: shared ? 'light' : 'high',
    slots,
    representativeSampleKeys: slots.map((slot) => slot.generationKey).slice(0, 3),
  };
}

function recipient(targetKey: string, email: string): OutreachV3GenerationRecipient {
  return {
    targetKey,
    displayName: targetKey.toUpperCase(),
    email,
    title: null,
    organization: null,
    source: 'directory_member' as const,
    sourceId: targetKey,
    clientId: null,
    governmentLevel: 'federal',
    chamber: 'house',
    state: 'VA',
    district: '01',
    snapshotHash: 'c'.repeat(64),
  };
}

function emptyContext() {
  return {
    requiredPolicy: [],
    writingGuidance: [],
    campaignFacts: [],
    targetSpecific: [],
    groupSafe: [],
  };
}

function identity(generationKey: string): OutreachV3DraftVersionIdentity {
  return {
    versionId: `version-${generationKey}`,
    artifactId: `artifact-${generationKey}`,
    generationKey,
    contentHash: `sha256:${'d'.repeat(64)}`,
    planHash: 'a'.repeat(64),
    generationStatus: 'generated',
    auditStatus: 'passed',
    baseApprovalStatus: 'not_required',
  };
}

function draft(generationKey: string, email?: string): OutreachV3PreflightDraft {
  const version = identity(generationKey);
  return {
    version,
    approval: createOutreachV3DraftApprovalSnapshot({
      sessionId: '11111111-1111-4111-8111-111111111111',
      stateVersion: 10,
      specHash: 'b'.repeat(64),
      planHash: 'a'.repeat(64),
      version,
    }),
    localDirty: false,
    recipientSnapshotCurrent: true,
    recipientSnapshot: { email: email ?? `${generationKey.slice(-1)}@example.test` },
  };
}

describe('Outreach V3 deterministic preflight', () => {
  it('requires sender, exact approvals, current recipients and all intended slots', () => {
    const campaignPlan = plan();
    const result = evaluateOutreachV3Preflight({
      plan: campaignPlan,
      drafts: [draft('slot-a', 'a@example.test'), draft('slot-b', 'b@example.test')],
      senderConnectionId: 'sender-1',
      senderAuthorized: true,
      attachmentsReady: true,
    });
    expect(result.eligible).toBe(true);
    expect(result.draftVersionIds).toEqual(['version-slot-a', 'version-slot-b']);
    expect(result.blockers).toEqual([]);
  });

  it('blocks a clean audited draft that lacks explicit V3 exact-version approval', () => {
    const missingApproval = draft('slot-a', 'a@example.test');
    missingApproval.approval = null;
    const result = evaluateOutreachV3Preflight({
      plan: plan(),
      drafts: [missingApproval, draft('slot-b', 'b@example.test')],
      senderConnectionId: 'sender-1',
      senderAuthorized: true,
      attachmentsReady: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('DRAFT_NOT_EXACTLY_APPROVED');
  });

  it('blocks stale recipient snapshots even when the draft text itself is approved', () => {
    const stale = draft('slot-a', 'a@example.test');
    stale.recipientSnapshotCurrent = false;
    const result = evaluateOutreachV3Preflight({
      plan: plan(),
      drafts: [stale, draft('slot-b', 'b@example.test')],
      senderConnectionId: 'sender-1',
      senderAuthorized: true,
      attachmentsReady: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('RECIPIENT_SNAPSHOT_STALE');
  });

  it('blocks duplicate recipient mailboxes across separate logical targets', () => {
    const result = evaluateOutreachV3Preflight({
      plan: plan(),
      drafts: [draft('slot-a', 'same@example.test'), draft('slot-b', 'same@example.test')],
      senderConnectionId: 'sender-1',
      senderAuthorized: true,
      attachmentsReady: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('RECIPIENT_EMAIL_COLLISION');
    expect(result.draftResults.every((entry) => !entry.eligible)).toBe(true);
  });

  it('requires every intended shared-thread member to have a distinct email', () => {
    const group = draft('slot-group');
    group.recipientSnapshot = {
      kind: 'shared_thread',
      groupMembers: [
        { email: 'a@example.test', name: 'A' },
        { email: '', name: 'B' },
      ],
    };
    const result = evaluateOutreachV3Preflight({
      plan: plan(true),
      drafts: [group],
      senderConnectionId: 'sender-1',
      senderAuthorized: true,
      attachmentsReady: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('RECIPIENT_EMAIL_MISSING');
  });

  it('allows explicit exclusions but never an unknown exclusion key', () => {
    const result = evaluateOutreachV3Preflight({
      plan: plan(),
      drafts: [draft('slot-a', 'a@example.test')],
      senderConnectionId: 'sender-1',
      senderAuthorized: true,
      attachmentsReady: true,
      excludedGenerationKeys: ['slot-b'],
    });
    expect(result.eligible).toBe(true);
    expect(result.excludedGenerationKeys).toEqual(['slot-b']);

    const bad = evaluateOutreachV3Preflight({
      plan: plan(),
      drafts: [draft('slot-a', 'a@example.test'), draft('slot-b', 'b@example.test')],
      senderConnectionId: 'sender-1',
      senderAuthorized: true,
      attachmentsReady: true,
      excludedGenerationKeys: ['not-a-slot'],
    });
    expect(bad.eligible).toBe(false);
    expect(bad.blockers).toContain('EXCLUSION_NOT_IN_PLAN');
  });

  it('makes test-send preflight exactly one selected logical draft', () => {
    const result = evaluateOutreachV3Preflight({
      plan: plan(),
      drafts: [draft('slot-a', 'a@example.test'), draft('slot-b', 'b@example.test')],
      senderConnectionId: 'sender-1',
      senderAuthorized: true,
      attachmentsReady: true,
      testMode: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('TEST_SEND_REQUIRES_ONE_DRAFT');
  });
});
