import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from './engagement.service.js';
import { GenerationGatewayService } from './generation/generation-gateway.service.js';
import {
  OutreachJobService,
  type SubmitOutreachJobInput,
} from './outreach-job.service.js';
import { retryOnceAfterPrismaUnique } from './prisma-unique-retry.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

/**
 * Production DI wrapper for concurrent outreach-job submissions.
 *
 * The request/core provider deliberately owns NO timer. EngagementWorkersModule
 * registers the explicit timer shell and calls runWorkerTick().
 */
@Injectable()
export class RaceSafeOutreachJobService extends OutreachJobService {
  constructor(
    prisma: PrismaService,
    engagement: EngagementService,
    gateway: GenerationGatewayService,
    config: ConfigService<AppConfig, true>,
    runtimePolicy: EngagementRuntimePolicyService,
  ) {
    super(prisma, engagement, gateway, config, runtimePolicy);
  }

  /** Request/core construction must never start a worker timer. */
  override onModuleInit(): void {}

  override onModuleDestroy(): void {}

  /** Explicit worker-shell entry point over the base class's private sweep. */
  runWorkerTick(): Promise<void> {
    return (this as unknown as { tick(): Promise<void> }).tick();
  }

  override submit(
    ctx: TenantContext,
    input: SubmitOutreachJobInput,
  ): Promise<{ jobId: string; deduped: boolean }> {
    return retryOnceAfterPrismaUnique(() => super.submit(ctx, input));
  }
}
