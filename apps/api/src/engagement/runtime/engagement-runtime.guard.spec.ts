import { describe, expect, it } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ENGAGEMENT_RUNTIME_ACTION_KEY,
  EngagementRuntimeAction,
  type EngagementRuntimeActionMetadata,
} from './engagement-runtime-action.decorator.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import { EngagementRuntimeGuard } from './engagement-runtime.guard.js';

function makePolicy(
  overrides: Partial<ConstructorParameters<typeof EngagementRuntimePolicyService>[0]> = {},
) {
  return new EngagementRuntimePolicyService({
    serviceName: 'engagement-api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'disabled',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
    ...overrides,
  });
}

function contextFor(
  controllerName: string,
  handlerName: string,
  decorated?: EngagementRuntimeActionMetadata,
): ExecutionContext {
  const Controller = { [controllerName]: class {} }[controllerName] as new () => Record<
    string,
    unknown
  >;
  const namedHandler = { [handlerName]() {} }[handlerName];
  Object.defineProperty(Controller.prototype, handlerName, {
    configurable: true,
    value: namedHandler,
  });
  const descriptor = Object.getOwnPropertyDescriptor(Controller.prototype, handlerName)!;
  if (decorated) {
    EngagementRuntimeAction(decorated.action, {
      requiresCallbacks: decorated.requiresCallbacks,
      testMode: decorated.testMode,
    })(Controller.prototype, handlerName, descriptor);
  }
  const handler = descriptor.value as () => void;
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }),
    switchToRpc: () => ({ getData: () => undefined, getContext: () => undefined }),
    switchToWs: () => ({ getData: () => undefined, getClient: () => undefined }),
  } as unknown as ExecutionContext;
}

describe('EngagementRuntimeAction', () => {
  it('stores metadata on the handler function read by Nest Reflector', () => {
    const ctx = contextFor('UnregisteredController', 'handler', {
      action: 'outreach_send',
    });
    expect(new Reflector().get(ENGAGEMENT_RUNTIME_ACTION_KEY, ctx.getHandler())).toEqual({
      action: 'outreach_send',
      requiresCallbacks: false,
      testMode: false,
    });
  });
});

describe('EngagementRuntimeGuard', () => {
  const reflector = new Reflector();

  it('admits integration routes and stored reads but rejects send routes in integrations_only', () => {
    const guard = new EngagementRuntimeGuard(
      reflector,
      makePolicy({
        externalActions: 'integrations_only',
        callbacksEnabled: true,
      }),
    );
    for (const [controller, handler] of [
      ['EngagementController', 'listIntegrations'],
      ['GoogleIntegrationActionsController', 'syncConnection'],
      ['MicrosoftIntegrationActionsController', 'sync'],
      ['MicrosoftIntegrationActionsController', 'subscriptions'],
      ['GoogleIntegrationActionsController', 'start'],
      ['MicrosoftCallbacksController', 'callback'],
      ['GoogleCallbacksController', 'callback'],
      ['MicrosoftCallbacksController', 'notifications'],
    ] as const) {
      expect(guard.canActivate(contextFor(controller, handler))).toBe(true);
    }
    for (const [controller, handler] of [
      ['EngagementController', 'sendSingleMail'],
      ['EngagementController', 'sendCampaignTest'],
      ['NewsletterOutreachController', 'send'],
      ['NewsletterOutreachController', 'test'],
      ['OutreachV3SendController', 'testSend'],
      ['OutreachV3SendController', 'createIntent'],
      ['GoogleIntegrationActionsController', 'disconnect'],
    ] as const) {
      expect(() => guard.canActivate(contextFor(controller, handler))).toThrow();
    }
  });

  it('allows an ordinary DB-local route with no registry or decorator metadata', () => {
    const guard = new EngagementRuntimeGuard(reflector, makePolicy());
    expect(guard.canActivate(contextFor('OutcomeController', 'list'))).toBe(true);
  });

  it('denies a registry route even when its decorator is accidentally absent', () => {
    const guard = new EngagementRuntimeGuard(reflector, makePolicy());
    expect(() =>
      guard.canActivate(contextFor('EngagementController', 'copyProspectAttachment')),
    ).toThrow();
  });

  it.each(['createAttachmentUploadUrl', 'confirmAttachment', 'deleteAttachment'])(
    'admits internal storage handler %s with external actions disabled',
    (handler) => {
      const guard = new EngagementRuntimeGuard(reflector, makePolicy());
      expect(guard.canActivate(contextFor('EngagementController', handler))).toBe(true);
    },
  );

  it.each([
    'extractAttachmentText',
    'extractAttachmentContext',
    'copyProspectAttachment',
    'prepPdfAttachment',
    'sendSingleMail',
  ])('retains external-action refusal for %s', (handler) => {
    const guard = new EngagementRuntimeGuard(reflector, makePolicy());
    expect(() => guard.canActivate(contextFor('EngagementController', handler))).toThrow();
  });

  it('denies the internal provider-credential route in shadow mode', () => {
    const guard = new EngagementRuntimeGuard(reflector, makePolicy());
    expect(() =>
      guard.canActivate(contextFor('InternalAiCredentialsController', 'resolve')),
    ).toThrow();
  });

  it.each(['MicrosoftCallbacksController', 'GoogleCallbacksController'])('returns external-action denial before callback denial for %s in shadow mode', (controller) => {
    const guard = new EngagementRuntimeGuard(reflector, makePolicy());
    try {
      guard.canActivate(contextFor(controller, 'callback'));
      throw new Error('expected denial');
    } catch (error) {
      expect(JSON.stringify(error)).toContain('ENGAGEMENT_EXTERNAL_ACTION_DISABLED');
    }
  });


  it.each(['MicrosoftCallbacksController', 'GoogleCallbacksController'])('keeps the callback switch enforced for %s when external actions are enabled', (controller) => {
    const guard = new EngagementRuntimeGuard(reflector, makePolicy({ externalActions: 'enabled' }));
    expect(() => guard.canActivate(contextFor(controller, 'callback'))).toThrow();
    const enabled = new EngagementRuntimeGuard(reflector, makePolicy({ externalActions: 'enabled', callbacksEnabled: true }));
    expect(enabled.canActivate(contextFor(controller, 'callback'))).toBe(true);
  });

  it('fails closed when decorator metadata conflicts with the exact registry', () => {
    const guard = new EngagementRuntimeGuard(reflector, makePolicy());
    try {
      guard.canActivate(
        contextFor('EngagementController', 'sendBatchEmails', {
          action: 'outreach_generate',
        }),
      );
      throw new Error('expected runtime policy mismatch');
    } catch (error) {
      expect(JSON.stringify(error)).toContain('ENGAGEMENT_RUNTIME_POLICY_MISMATCH');
    }
  });

  it('allows registered actions in active mode', () => {
    const guard = new EngagementRuntimeGuard(
      reflector,
      makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      }),
    );
    expect(guard.canActivate(contextFor('EngagementController', 'sendBatchEmails'))).toBe(
      true,
    );
  });

  it('allows only the explicit test-send route in test_only mode', () => {
    const guard = new EngagementRuntimeGuard(
      reflector,
      makePolicy({ externalActions: 'test_only' }),
    );
    expect(guard.canActivate(contextFor('EngagementController', 'sendCampaignTest'))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextFor('EngagementController', 'sendCampaignEmails')),
    ).toThrow();
  });
});
