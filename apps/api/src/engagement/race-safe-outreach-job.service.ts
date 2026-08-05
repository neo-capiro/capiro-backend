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
 * The unique key already prevents duplicate fan-out. Retrying the losing
 * transaction once lets OutreachJobService's ordinary lookup return the durable
 * winner instead of leaking a raw Prisma P2002 to the browser.
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

  override submit(
    ctx: TenantContext,
    input: SubmitOutreachJobInput,
  ): Promise<{ jobId: string; deduped: boolean }> {
    return retryOnceAfterPrismaUnique(() => super.submit(ctx, input));
  }
}
