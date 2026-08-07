import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { EngagementService } from '../engagement.service.js';
import { guardEngagementServiceRuntime } from '../governed-engagement.factory.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import {
  ENGAGEMENT_DENIAL_BOUNDARY_HEADER,
  ENGAGEMENT_DENIAL_BOUNDARY_ROUTE_GUARD,
  EngagementRuntimeGuard,
  conditionalRouteMetadata,
} from './engagement-runtime.guard.js';

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

function contextFor(
  controllerName: string,
  handlerName: string,
  body?: unknown,
  headers: Record<string, string> = {},
): ExecutionContext {
  const Controller = { [controllerName]: class {} }[controllerName] as new () => object;
  const handler = { [handlerName]() {} }[handlerName];
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({
      getRequest: () => ({ body }),
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('shadow-safe local Engagement actions', () => {
  const reflector = new Reflector();

  it('allows open-email because it only updates local state and returns mailto:', () => {
    const guard = new EngagementRuntimeGuard(reflector, shadowPolicy());
    expect(guard.canActivate(contextFor('EngagementController', 'openOutreachEmail'))).toBe(true);
  });

  it.each(['manual', 'revert'] as const)(
    'allows createDraftVersion editKind=%s as a local immutable write',
    (editKind) => {
      const guard = new EngagementRuntimeGuard(reflector, shadowPolicy());
      expect(
        guard.canActivate(
          contextFor('EngagementController', 'createDraftVersion', { editKind }),
        ),
      ).toBe(true);
    },
  );

  it.each([undefined, {}, { editKind: 'improve' }, { editKind: 'unknown' }])(
    'fails closed for generation-capable or malformed draft-version input %#',
    (body) => {
      const headers: Record<string, string> = {};
      const guard = new EngagementRuntimeGuard(reflector, shadowPolicy());
      expect(() =>
        guard.canActivate(
          contextFor('EngagementController', 'createDraftVersion', body, headers),
        ),
      ).toThrow();
      expect(headers[ENGAGEMENT_DENIAL_BOUNDARY_HEADER]).toBe(
        ENGAGEMENT_DENIAL_BOUNDARY_ROUTE_GUARD,
      );
    },
  );

  it('classifies only Improve/malformed createDraftVersion calls as generation', () => {
    expect(
      conditionalRouteMetadata('EngagementController', 'createDraftVersion', {
        editKind: 'manual',
      }),
    ).toBeUndefined();
    expect(
      conditionalRouteMetadata('EngagementController', 'createDraftVersion', {
        editKind: 'revert',
      }),
    ).toBeUndefined();
    expect(
      conditionalRouteMetadata('EngagementController', 'createDraftVersion', {
        editKind: 'improve',
      }),
    ).toMatchObject({ action: 'outreach_generate' });
    expect(
      conditionalRouteMetadata('EngagementController', 'createDraftVersion', {}),
    ).toMatchObject({ action: 'outreach_generate' });
  });

  it('does not block the service-level local mailto method', async () => {
    const openOutreachInConnectedEmail = jest.fn(async () => ({ mailtoUrl: 'mailto:test@example.com' }));
    const guarded = guardEngagementServiceRuntime(
      { openOutreachInConnectedEmail } as unknown as EngagementService,
      shadowPolicy(),
    );

    await expect(
      (guarded.openOutreachInConnectedEmail as unknown as () => Promise<unknown>)(),
    ).resolves.toEqual({ mailtoUrl: 'mailto:test@example.com' });
    expect(openOutreachInConnectedEmail).toHaveBeenCalledTimes(1);
  });

  it('still blocks a real service-level provider send before invocation', () => {
    const sendCampaign = jest.fn(async () => ({ unsafe: true }));
    const guarded = guardEngagementServiceRuntime(
      { sendCampaign } as unknown as EngagementService,
      shadowPolicy(),
    );

    expect(() =>
      (guarded.sendCampaign as unknown as () => Promise<unknown>)(),
    ).toThrow();
    expect(sendCampaign).not.toHaveBeenCalled();
  });
});
