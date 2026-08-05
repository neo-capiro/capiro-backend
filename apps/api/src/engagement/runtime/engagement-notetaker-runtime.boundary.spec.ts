import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { MeetingBotProvider } from '../notetaker/meeting-bot.provider.js';
import type { NotetakerService } from '../notetaker/notetaker.service.js';
import {
  guardMeetingBotProvider,
  guardNotetakerService,
  MEETING_BOT_EXTERNAL_METHODS,
  NOTETAKER_BACKGROUND_METHODS,
  NOTETAKER_EXTERNAL_METHODS,
} from './engagement-notetaker-runtime.boundary.js';
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

function invokeAndCapture(
  service: Record<string, (...args: unknown[]) => unknown>,
  methodName: string,
): unknown {
  try {
    return service[methodName]?.({});
  } catch (error) {
    return error;
  }
}

describe('Notetaker runtime boundary', () => {
  it.each(Object.keys(MEETING_BOT_EXTERNAL_METHODS))(
    'blocks raw Recall provider method %s',
    (methodName) => {
      const implementation = jest.fn(async () => undefined);
      const guarded = guardMeetingBotProvider(
        { [methodName]: implementation } as unknown as MeetingBotProvider,
        shadowPolicy(),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      const caught = invokeAndCapture(guarded, methodName);
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect(implementation).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(NOTETAKER_EXTERNAL_METHODS))(
    'blocks external service method %s before the provider implementation',
    (methodName) => {
      const implementation = jest.fn(async () => undefined);
      const guarded = guardNotetakerService(
        { [methodName]: implementation } as unknown as NotetakerService,
        shadowPolicy(),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      const caught = invokeAndCapture(guarded, methodName);
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect(implementation).not.toHaveBeenCalled();
    },
  );

  it.each([...NOTETAKER_BACKGROUND_METHODS])(
    'blocks background method %s before Prisma or Recall work',
    (methodName) => {
      const implementation = jest.fn(async () => undefined);
      const guarded = guardNotetakerService(
        { [methodName]: implementation } as unknown as NotetakerService,
        shadowPolicy(),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      const caught = invokeAndCapture(guarded, methodName);
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect((caught as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'ENGAGEMENT_BACKGROUND_OWNER_MISMATCH',
      });
      expect(implementation).not.toHaveBeenCalled();
    },
  );

  it('preserves webhook signature parsing and database-local status reads', () => {
    const verify = jest.fn(() => ({ kind: 'unknown' }));
    const provider = guardMeetingBotProvider(
      { verifyAndParseWebhook: verify } as unknown as MeetingBotProvider,
      shadowPolicy(),
    );
    expect(provider.verifyAndParseWebhook(Buffer.from('{}'), {})).toEqual({ kind: 'unknown' });
    expect(verify).toHaveBeenCalledTimes(1);

    const localRead = jest.fn(() => ({ status: 'done' }));
    const guarded = guardNotetakerService(
      { getSessionForMeeting: localRead } as unknown as NotetakerService,
      shadowPolicy(),
    );
    expect(guarded.getSessionForMeeting({} as never, 'meeting-1')).toEqual({ status: 'done' });
    expect(localRead).toHaveBeenCalledTimes(1);
  });
});
