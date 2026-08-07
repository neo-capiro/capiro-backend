import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { EngagementService } from '../engagement.service.js';
import {
  guardEngagementServiceRuntime,
  guardedEngagementServiceMethods,
} from '../governed-engagement.factory.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

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

describe('EngagementService runtime boundary', () => {
  it('covers all EngagementService methods behind externally sensitive controller handlers', () => {
    expect(guardedEngagementServiceMethods()).toEqual({
      previewAiTemplate: { action: 'outreach_generate' },
      generateTalkingPoints: { action: 'outreach_generate' },
      generateBatchEmails: { action: 'outreach_generate' },
      generateOutreachDraft: { action: 'outreach_generate' },
      generateCampaignEmail: { action: 'outreach_generate' },
      generateMeetingPrep: { action: 'meeting_prep_generate' },
      generateMeetingDebriefDraft: { action: 'meeting_debrief_generate' },
      sendBatchEmails: { action: 'outreach_send' },
      sendCampaign: { action: 'outreach_send' },
      sendCampaignEmails: { action: 'outreach_send' },
      sendCampaignTest: { action: 'outreach_test_send', testMode: true },
      createAttachmentUploadUrl: { action: 'attachment_external_write' },
      confirmAttachment: { action: 'attachment_external_write' },
      extractAttachmentText: { action: 'attachment_external_read' },
      deleteAttachment: { action: 'attachment_external_write' },
    });
  });

  it.each(Object.keys(guardedEngagementServiceMethods()))(
    'blocks %s synchronously before the implementation runs',
    (methodName) => {
      const implementation = jest.fn(async () => ({ unsafe: true }));
      const raw = { [methodName]: implementation } as unknown as EngagementService;
      const guarded = guardEngagementServiceRuntime(raw, shadowPolicy()) as unknown as Record<
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

  it('preserves ordinary database-local reads', () => {
    const capabilities = jest.fn(() => ({ ok: true }));
    const raw = { capabilities } as unknown as EngagementService;
    const guarded = guardEngagementServiceRuntime(raw, shadowPolicy());

    expect(guarded.capabilities()).toEqual({ ok: true });
    expect(capabilities).toHaveBeenCalledTimes(1);
  });
});
