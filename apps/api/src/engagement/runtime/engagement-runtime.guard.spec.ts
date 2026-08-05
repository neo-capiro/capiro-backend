import { describe, it, expect } from '@jest/globals';
import { EngagementRuntimeGuard } from './engagement-runtime.guard.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import {
  ENGAGEMENT_RUNTIME_ACTION_KEY,
  type EngagementRuntimeActionMetadata,
} from './engagement-runtime-action.decorator.js';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

function makePolicy(overrides: Partial<{
  serviceName: 'api' | 'engagement-api';
  processMode: 'shadow' | 'active';
  backgroundOwner: 'api' | 'engagement-api' | 'disabled';
  externalActions: 'disabled' | 'test_only' | 'enabled';
  callbacksEnabled: boolean;
  recallWebhookEnabled: boolean;
}> = {}) {
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

// Simulate what NestJS does: the handler is a method on a class prototype.
// The decorator stores metadata on the handler function itself (NestJS
// Reflector reads from the handler, not the class).
function makeContext(metadata?: EngagementRuntimeActionMetadata): ExecutionContext {
  class TestController {
    handler() {}
  }
  const handler = TestController.prototype.handler;
  // The decorator uses Reflect.defineMetadata(key, value, target, propertyKey).
  // NestJS Reflector.get(key, handler) reads metadata stored on the handler
  // function itself (not on the class prototype).
  if (metadata) {
    Reflect.defineMetadata(ENGAGEMENT_RUNTIME_ACTION_KEY, metadata, handler);
  }

  return {
    getHandler: () => handler,
    getClass: () => TestController,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }),
    switchToRpc: () => ({ getData: () => undefined, getContext: () => undefined }),
    switchToWs: () => ({ getData: () => undefined, getClient: () => undefined }),
  } as unknown as ExecutionContext;
}

describe('EngagementRuntimeGuard', () => {
  const reflector = new Reflector();

  describe('routes without action metadata', () => {
    it('allows DB-local routes (no metadata)', () => {
      const policy = makePolicy();
      const guard = new EngagementRuntimeGuard(reflector, policy);
      const ctx = makeContext(); // no metadata
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('routes with external action metadata — shadow mode', () => {
    const policy = makePolicy(); // shadow/disabled
    const guard = new EngagementRuntimeGuard(reflector, policy);

    it('throws for outreach_send', () => {
      const ctx = makeContext({
        action: 'outreach_send',
        requiresCallbacks: false,
        testMode: false,
      });
      expect(() => guard.canActivate(ctx)).toThrow();
    });

    it('throws for integration_sync', () => {
      const ctx = makeContext({
        action: 'integration_sync',
        requiresCallbacks: false,
        testMode: false,
      });
      expect(() => guard.canActivate(ctx)).toThrow();
    });

    it('throws for notetaker_dispatch', () => {
      const ctx = makeContext({
        action: 'notetaker_dispatch',
        requiresCallbacks: false,
        testMode: false,
      });
      expect(() => guard.canActivate(ctx)).toThrow();
    });

    it('throws for meeting_prep_generate', () => {
      const ctx = makeContext({
        action: 'meeting_prep_generate',
        requiresCallbacks: false,
        testMode: false,
      });
      expect(() => guard.canActivate(ctx)).toThrow();
    });

    it('throws for attachment_external_write', () => {
      const ctx = makeContext({
        action: 'attachment_external_write',
        requiresCallbacks: false,
        testMode: false,
      });
      expect(() => guard.canActivate(ctx)).toThrow();
    });
  });

  describe('routes with callback metadata — shadow mode', () => {
    const policy = makePolicy(); // callbacks disabled
    const guard = new EngagementRuntimeGuard(reflector, policy);

    it('throws for OAuth callback with requiresCallbacks', () => {
      const ctx = makeContext({
        action: 'integration_oauth_callback',
        requiresCallbacks: true,
        testMode: false,
      });
      expect(() => guard.canActivate(ctx)).toThrow();
    });

    it('throws for Microsoft notifications with requiresCallbacks', () => {
      const ctx = makeContext({
        action: 'integration_notification',
        requiresCallbacks: true,
        testMode: false,
      });
      expect(() => guard.canActivate(ctx)).toThrow();
    });
  });

  describe('routes with action metadata — active mode', () => {
    const policy = makePolicy({
      serviceName: 'api',
      processMode: 'active',
      backgroundOwner: 'api',
      externalActions: 'enabled',
      callbacksEnabled: true,
      recallWebhookEnabled: true,
    });
    const guard = new EngagementRuntimeGuard(reflector, policy);

    it('allows outreach_send in active mode', () => {
      const ctx = makeContext({
        action: 'outreach_send',
        requiresCallbacks: false,
        testMode: false,
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows OAuth callback in active mode', () => {
      const ctx = makeContext({
        action: 'integration_oauth_callback',
        requiresCallbacks: true,
        testMode: false,
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('test_only mode', () => {
    const policy = makePolicy({
      externalActions: 'test_only',
    });
    const guard = new EngagementRuntimeGuard(reflector, policy);

    it('allows test_send with testMode=true', () => {
      const ctx = makeContext({
        action: 'outreach_test_send',
        requiresCallbacks: false,
        testMode: true,
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('throws for ordinary send in test_only mode', () => {
      const ctx = makeContext({
        action: 'outreach_send',
        requiresCallbacks: false,
        testMode: false,
      });
      expect(() => guard.canActivate(ctx)).toThrow();
    });
  });
});
