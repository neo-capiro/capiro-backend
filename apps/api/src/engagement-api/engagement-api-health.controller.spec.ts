import { describe, it, expect, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { EngagementApiHealthController } from './engagement-api-health.controller.js';

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

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const map: Record<string, unknown> = {
    RELEASE_SHA: 'UNVERIFIED',
    ...overrides,
  };
  return { get: (key: string) => map[key] } as unknown as ConfigService;
}

describe('EngagementApiHealthController', () => {
  let controller: EngagementApiHealthController;
  let prisma: { $queryRaw: jest.Mock };
  let config: ConfigService;
  let policy: EngagementRuntimePolicyService;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    config = makeConfig();
    policy = makePolicy();
    controller = new EngagementApiHealthController(config, prisma as unknown as PrismaService, policy);
  });

  describe('healthy response', () => {
    it('returns status ok when DB is healthy', async () => {
      const result = await controller.health();
      expect(result.status).toBe('ok');
      expect(result.service).toBe('engagement-api');
      expect(result.database.status).toBe('ok');
    });

    it('returns the release SHA from config', async () => {
      config = makeConfig({ RELEASE_SHA: 'abc123def456' });
      controller = new EngagementApiHealthController(
        config,
        prisma as unknown as PrismaService,
        policy,
      );
      const result = await controller.health();
      expect(result.releaseSha).toBe('abc123def456');
    });

    it('returns UNVERIFIED when RELEASE_SHA is unset', async () => {
      const result = await controller.health();
      expect(result.releaseSha).toBe('UNVERIFIED');
    });

    it('returns an ISO-8601 time', async () => {
      const result = await controller.health();
      expect(result.time).toBeTruthy();
      expect(() => new Date(result.time).toISOString()).not.toThrow();
    });
  });

  describe('DB failure', () => {
    it('returns status unavailable when DB fails', async () => {
      prisma.$queryRaw = jest.fn().mockRejectedValue(new Error('connection refused'));
      // The controller throws ServiceUnavailableException when DB fails.
      await expect(controller.health()).rejects.toThrow();
    });
  });

  describe('runtime posture', () => {
    it('returns the shadow posture', async () => {
      const result = await controller.health();
      expect(result.runtime.processMode).toBe('shadow');
      expect(result.runtime.backgroundOwner).toBe('disabled');
      expect(result.runtime.externalActions).toBe('disabled');
      expect(result.runtime.callbacksEnabled).toBe(false);
      expect(result.runtime.recallWebhookEnabled).toBe(false);
    });

    it('returns active posture when configured for active mode', async () => {
      policy = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      });
      controller = new EngagementApiHealthController(
        config,
        prisma as unknown as PrismaService,
        policy,
      );
      const result = await controller.health();
      expect(result.runtime.processMode).toBe('active');
      expect(result.runtime.backgroundOwner).toBe('api');
      expect(result.runtime.externalActions).toBe('enabled');
      expect(result.runtime.callbacksEnabled).toBe(true);
      expect(result.runtime.recallWebhookEnabled).toBe(true);
    });
  });

  describe('no secrets in response', () => {
    it('does not include DB host, DB name, or credentials', async () => {
      const result = await controller.health();
      const json = JSON.stringify(result);
      expect(json).not.toMatch(/DATABASE_URL|DB_HOST|DB_PASSWORD|secret|password|apiKey|token/i);
    });

    it('does not include tenant IDs or queue contents', async () => {
      const result = await controller.health();
      const json = JSON.stringify(result);
      expect(json).not.toMatch(/tenant|queue|clerk|oauth/i);
    });

    it('always reports service as engagement-api', async () => {
      const result = await controller.health();
      expect(result.service).toBe('engagement-api');
    });
  });
});
