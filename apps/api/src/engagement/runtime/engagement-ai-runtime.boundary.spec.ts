import { ServiceUnavailableException } from '@nestjs/common';
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
    (methodName) => {
      const implementation = jest.fn(async () => ({ ok: true }));
      const raw = {
        [methodName]: implementation,
      } as unknown as EngagementAiService;
      const guarded = guardEngagementAiService(raw, shadowPolicy()) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;

      let caught: unknown;
      try {
        void guarded[methodName]?.({});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect((caught as ServiceUnavailableException).getStatus()).toBe(503);
      expect((caught as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
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
