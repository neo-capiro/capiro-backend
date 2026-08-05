import { describe, expect, it, jest } from '@jest/globals';
import type { EngagementAiService } from '../engagement-ai.service.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import {
  guardEngagementAiService,
  guardedEngagementAiMethods,
} from './engagement-ai-runtime.boundary.js';

function shadowPolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'engagement-api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'disabled',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
  });
}

describe('Engagement AI runtime boundary', () => {
  it('covers every public provider-capable AI entry point', () => {
    expect(guardedEngagementAiMethods()).toEqual({
      generateMeetingPrep: 'meeting_prep_generate',
      generateMeetingDebrief: 'meeting_debrief_generate',
      generateOutreachDraft: 'outreach_generate',
      generateTalkingPoints: 'outreach_generate',
      generateCampaignEmail: 'outreach_generate',
      resolveOutreachCredentials: 'outreach_generate',
    });
  });

  it.each(Object.keys(guardedEngagementAiMethods()))(
    'blocks %s before the underlying implementation runs',
    async (methodName) => {
      const implementation = jest.fn(async () => ({ ok: true }));
      const raw = {
        [methodName]: implementation,
      } as unknown as EngagementAiService;
      const guarded = guardEngagementAiService(raw, shadowPolicy()) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;

      await expect(guarded[methodName]?.({})).rejects.toMatchObject({
        status: 503,
      });
      expect(implementation).not.toHaveBeenCalled();
    },
  );

  it('leaves non-provider methods callable', () => {
    const capabilities = jest.fn(() => ({ enabled: false }));
    const raw = { capabilities } as unknown as EngagementAiService;
    const guarded = guardEngagementAiService(raw, shadowPolicy());

    expect(guarded.capabilities()).toEqual({ enabled: false });
    expect(capabilities).toHaveBeenCalledTimes(1);
  });
});
