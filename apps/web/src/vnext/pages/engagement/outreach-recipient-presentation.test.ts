import { describe, expect, it } from 'vitest';
import { recipientPresentation } from './outreach-recipient-presentation.js';
import type { OutreachV3DraftArtifact, OutreachV3GenerationPlan } from './engagement-api.js';

/**
 * Regression for the "member names display as a raw key" defect
 * (docs/runbooks/outreach-ui-defects-investigation-20260826.md, Defect 1).
 *
 * Root cause: the server's plan payload (see
 * apps/api/src/outreach-v3/generation/outreach-v3-generation-plan.ts
 * `toRecipient()`) sends each recipient as
 * `{ targetKey, displayName, email, title, organization, chamber, ... }` —
 * there is no `label` or `targetType` field anywhere in that response.
 * `recipientPresentation()` was reading `recipient?.label` and
 * `recipient?.targetType`, both always undefined, so it silently fell
 * through to the raw `recipientKey`/`generationKey`
 * (e.g. "directory_member:member-3055") instead of the real name.
 *
 * This test builds a plan/draft pair shaped exactly like the real server
 * response (using the field names the API actually emits) and asserts the
 * UI-facing label is the human name, never the internal key.
 */
describe('recipientPresentation — real name vs. raw recipient key', () => {
  function buildDraft(generationKey: string, recipientKey: string): OutreachV3DraftArtifact {
    return {
      id: `draft-${recipientKey}`,
      outreachRecordId: 'session-1',
      generationKey,
      recipientKey,
      audienceKind: 'individual',
      currentVersion: 2,
      current: {
        id: `version-${recipientKey}`,
        version: 2,
        generationStatus: 'complete',
        auditStatus: 'passed',
        approvalStatus: 'pending',
        subject: 'Subject',
        body: 'Body',
        createdAt: new Date().toISOString(),
        auditChecks: [],
      } as unknown as OutreachV3DraftArtifact['current'],
      history: [],
    };
  }

  function buildPlan(overrides: {
    generationKey: string;
    displayName: string;
    email: string | null;
    organization?: string | null;
  }): OutreachV3GenerationPlan {
    return {
      planVersion: 'outreach_v3_generation_plan_v1',
      sessionId: 'session-1',
      stateVersion: 1,
      specHash: 'hash',
      planHash: 'plan-hash',
      deliveryPattern: 'personalized_separate',
      representativeSampleKeys: [],
      eligible: true,
      slots: [
        {
          generationKey: overrides.generationKey,
          audienceKind: 'individual',
          recipients: [
            {
              targetKey: overrides.generationKey,
              // The real server shape — NOT `label`, NOT `targetType`.
              displayName: overrides.displayName,
              email: overrides.email,
            } as unknown as OutreachV3GenerationPlan['slots'][number]['recipients'][number],
          ],
        },
      ],
    } as unknown as OutreachV3GenerationPlan;
  }

  it('shows the real recipient name, not the raw "directory_member:member-3055" key', () => {
    const generationKey = 'v3:session-1:target:directory_member:member-3055';
    const draft = buildDraft(generationKey, 'directory_member:member-3055');
    const plan = buildPlan({
      generationKey,
      displayName: 'Alma Adams',
      email: 'alma@almaadamsforcongress.com',
    });

    const presentation = recipientPresentation(draft, plan);

    expect(presentation.label).toBe('Alma Adams');
    expect(presentation.label).not.toContain('directory_member');
    expect(presentation.label).not.toBe(draft.recipientKey);
    expect(presentation.label).not.toBe(draft.generationKey);
  });

  it('shows the real recipient name for a second recipient in the same plan (matches the reported screenshot)', () => {
    const generationKey = 'v3:session-1:target:directory_member:member-103';
    const draft = buildDraft(generationKey, 'directory_member:member-103');
    const plan = buildPlan({
      generationKey,
      displayName: 'Representative Member 103',
      email: null,
    });

    const presentation = recipientPresentation(draft, plan);

    expect(presentation.label).toBe('Representative Member 103');
    expect(presentation.label).not.toContain('directory_member');
  });

  it('falls back to the raw key only when the plan truly has no matching recipient (not the common case)', () => {
    const draft = buildDraft('v3:session-1:target:unmatched', 'unmatched-key');
    const plan = buildPlan({
      generationKey: 'a-totally-different-key',
      displayName: 'Someone Else',
      email: null,
    });

    const presentation = recipientPresentation(draft, plan);

    // No slot in the plan matches this draft's generationKey, so there is
    // genuinely no real name available — the raw-key fallback is correct
    // ONLY in this case, not for every recipient as the bug caused.
    expect(presentation.label).toBe(draft.recipientKey);
  });
});
