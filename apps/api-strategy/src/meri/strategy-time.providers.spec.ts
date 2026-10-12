import { describe, expect, it, jest } from '@jest/globals';
import type { Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { systemDelay, systemRandom, systemWallClock, type WallClock } from '@capiro/shared';
import { MeriModule } from './meri.module.js';
import { MeriService } from './meri.service.js';
import { DraftJobService } from './draft-job.service.js';
import { RAW_STRATEGY_MERI_SERVICE } from './governed-strategy-meri.factory.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { StrategyAiCredentialResolver } from './strategy-ai-credential.resolver.js';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import { FirmPhasesService } from '../firm-phases/firm-phases.service.js';
import { ReferenceService } from '../reference/reference.service.js';
import { StrategyAttachmentResolver } from './strategy-attachment.resolver.js';
import { StewardService } from '../context/steward.service.js';
import { StrategyConversationService } from './strategy-conversation.service.js';
import {
  STRATEGY_CONTEXT_RETRY, STRATEGY_TIME_PROVIDERS, STRATEGY_WALL_CLOCK,
  type ContextRetryRuntime,
} from './strategy-time.providers.js';

const moduleProviders = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MeriModule) as Provider[];
const rawProvider = moduleProviders.find((p) => typeof p === 'object' && p && 'provide' in p && p.provide === RAW_STRATEGY_MERI_SERVICE)!;
const draftJobProvider = moduleProviders.find((p) => p === DraftJobService)!;

function dependencies() {
  return [
    { provide: PrismaService, useValue: {} },
    { provide: VersioningService, useValue: {} },
    { provide: StrategyAiCredentialResolver, useValue: {} },
    { provide: StrategyOrchestratorClient, useValue: {} },
    { provide: FirmPhasesService, useValue: { list: jest.fn(async () => []) } },
    { provide: ReferenceService, useValue: { getCalendars: jest.fn(async () => ({ congress: [], ppbeLanes: [], ppbeCurrentPhases: [] })) } },
    { provide: StrategyAttachmentResolver, useValue: {} },
    { provide: StewardService, useValue: {} },
    { provide: StrategyConversationService, useValue: {} },
  ];
}

describe('Strategy grounding time providers', () => {
  it('registers the canonical lazy defaults in the existing Meri module', () => {
    expect(moduleProviders).toEqual(expect.arrayContaining(STRATEGY_TIME_PROVIDERS));
    expect(STRATEGY_TIME_PROVIDERS[0]!.useValue).toBe(systemWallClock);
    expect(STRATEGY_TIME_PROVIDERS[1]!.useValue).toEqual({ random: systemRandom, delay: systemDelay });
    expect(rawProvider).toBeDefined();
    expect(draftJobProvider).toBeDefined();
  });

  it('requires the clock token for the actual raw Meri constructor', async () => {
    await expect(Test.createTestingModule({
      providers: [rawProvider, ...dependencies(), { provide: STRATEGY_CONTEXT_RETRY, useValue: { random: () => 0, delay: async () => undefined } }],
    }).compile()).rejects.toThrow('strategy.wall-clock');
  });

  it('requires the retry token for the actual draft-job constructor', async () => {
    await expect(Test.createTestingModule({ providers: [draftJobProvider, ...dependencies()] }).compile())
      .rejects.toThrow('strategy.context-retry');
  });

  it('uses overridden tokens through real Nest injection and the actual grounding/retry methods', async () => {
    const clock: WallClock = jest.fn(() => new Date(2026, 9, 1).getTime());
    const random = jest.fn(() => 0.5);
    const delay = jest.fn<(ms: number) => Promise<void>>(async () => undefined);
    const runtime: ContextRetryRuntime = { random, delay };
    const fakes = dependencies();
    const phases = fakes.find((p) => p.provide === FirmPhasesService)!.useValue as { list: jest.Mock<() => Promise<unknown[]>> };
    phases.list.mockRejectedValueOnce({ code: 'P1001' });
    const module = await Test.createTestingModule({
      providers: [rawProvider, draftJobProvider, ...fakes, ...STRATEGY_TIME_PROVIDERS],
    }).overrideProvider(STRATEGY_WALL_CLOCK).useValue(clock)
      .overrideProvider(STRATEGY_CONTEXT_RETRY).useValue(runtime).compile();
    try {
      const raw = module.get<MeriService>(RAW_STRATEGY_MERI_SERVICE);
      expect((await raw.grounding('tenant')).fiscal.fys).toEqual([2027, 2028, 2029]);
      expect(clock).toHaveBeenCalledTimes(1);
      expect(random).toHaveBeenCalledTimes(1);
      expect(delay.mock.calls).toEqual([[237]]);
      expect(module.get(DraftJobService)).toBeInstanceOf(DraftJobService);
    } finally {
      await module.close();
    }
  });
});
