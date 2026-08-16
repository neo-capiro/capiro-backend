import {
  createOutreachV3DraftApprovalSnapshot,
  deriveOutreachV3DraftLifecycle,
  isOutreachV3ExactVersionApproved,
  type OutreachV3DraftVersionIdentity,
} from './outreach-v3-draft-lifecycle.js';

function version(
  overrides: Partial<OutreachV3DraftVersionIdentity> = {},
): OutreachV3DraftVersionIdentity {
  return {
    versionId: '11111111-1111-4111-8111-111111111111',
    artifactId: '22222222-2222-4222-8222-222222222222',
    generationKey: 'v3:session:target:directory_member:alpha',
    contentHash: `sha256:${'a'.repeat(64)}`,
    planHash: 'b'.repeat(64),
    generationStatus: 'generated',
    auditStatus: 'passed',
    baseApprovalStatus: 'not_required',
    ...overrides,
  };
}

function approval(v = version()) {
  return createOutreachV3DraftApprovalSnapshot({
    sessionId: '33333333-3333-4333-8333-333333333333',
    stateVersion: 9,
    specHash: 'c'.repeat(64),
    planHash: v.planHash,
    version: v,
  });
}

describe('Outreach V3 draft lifecycle', () => {
  it('does not treat a clean audit with legacy not_required approval as V3 approval', () => {
    const v = version();
    const lifecycle = deriveOutreachV3DraftLifecycle({
      version: v,
      currentPlanHash: v.planHash,
      localDirty: false,
      approval: null,
    });
    expect(lifecycle).toEqual({
      state: 'ready_for_review',
      exactVersionApproved: false,
      sendReviewEligible: false,
      reason: 'awaiting_exact_version_approval',
    });
  });

  it('approves only the exact immutable version and content hash', () => {
    const v = version();
    const approved = approval(v);
    expect(isOutreachV3ExactVersionApproved(v, v.planHash, approved)).toBe(true);
    expect(
      isOutreachV3ExactVersionApproved(
        { ...v, versionId: '44444444-4444-4444-8444-444444444444' },
        v.planHash,
        approved,
      ),
    ).toBe(false);
    expect(
      isOutreachV3ExactVersionApproved(
        { ...v, contentHash: `sha256:${'d'.repeat(64)}` },
        v.planHash,
        approved,
      ),
    ).toBe(false);
  });

  it('marks the draft stale when the current Campaign Spec produces another plan', () => {
    const v = version();
    expect(
      deriveOutreachV3DraftLifecycle({
        version: v,
        currentPlanHash: 'e'.repeat(64),
        localDirty: false,
        approval: approval(v),
      }),
    ).toEqual(
      expect.objectContaining({
        state: 'stale',
        exactVersionApproved: false,
        sendReviewEligible: false,
        reason: 'campaign_plan_changed',
      }),
    );
  });

  it('keeps browser-local unsaved typing dirty and non-approvable', () => {
    const v = version();
    expect(
      deriveOutreachV3DraftLifecycle({
        version: v,
        currentPlanHash: v.planHash,
        localDirty: true,
        approval: approval(v),
      }),
    ).toEqual(
      expect.objectContaining({
        state: 'dirty',
        exactVersionApproved: false,
        sendReviewEligible: false,
      }),
    );
  });

  it('fails closed for pending, held, unavailable and failed generation states', () => {
    for (const [draft, expected] of [
      [version({ auditStatus: 'pending' }), 'held'],
      [version({ auditStatus: 'held', baseApprovalStatus: 'pending' }), 'held'],
      [version({ auditStatus: 'unavailable' }), 'audit_unavailable'],
      [version({ generationStatus: 'generation_failed' }), 'failed'],
    ] as const) {
      expect(
        deriveOutreachV3DraftLifecycle({
          version: draft,
          currentPlanHash: draft.planHash,
          localDirty: false,
          approval: null,
        }).state,
      ).toBe(expected);
    }
  });

  it('rejects author approval while audit is held or unavailable', () => {
    expect(() => approval(version({ auditStatus: 'held' }))).toThrow(
      'OUTREACH_V3_DRAFT_NOT_APPROVABLE:held',
    );
    expect(() => approval(version({ auditStatus: 'unavailable' }))).toThrow(
      'OUTREACH_V3_DRAFT_NOT_APPROVABLE:unavailable',
    );
  });

  it('becomes approved/send-review-eligible only with current exact approval', () => {
    const v = version();
    expect(
      deriveOutreachV3DraftLifecycle({
        version: v,
        currentPlanHash: v.planHash,
        localDirty: false,
        approval: approval(v),
      }),
    ).toEqual({
      state: 'approved',
      exactVersionApproved: true,
      sendReviewEligible: true,
      reason: 'exact_version_approved',
    });
  });
});
