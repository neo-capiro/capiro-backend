import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

@Controller('health')
export class EngagementApiHealthController {
  private readonly logger = new Logger(EngagementApiHealthController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runtimePolicy: EngagementRuntimePolicyService,
  ) {}

  @Get()
  async health() {
    let dbStatus: 'ok' | 'unavailable' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      // Do not place driver messages, hosts, database names, or credentials in
      // health logs or responses.
      this.logger.warn('Database health check failed');
      dbStatus = 'unavailable';
    }

    const snapshot = this.runtimePolicy.snapshot();
    const body = {
      status: dbStatus === 'ok' ? 'ok' : 'unavailable',
      service: 'engagement-api',
      releaseSha: this.config.get<string>('RELEASE_SHA') ?? 'UNVERIFIED',
      time: new Date().toISOString(),
      database: { status: dbStatus },
      runtime: {
        processMode: snapshot.processMode,
        backgroundOwner: snapshot.backgroundOwner,
        externalActions: snapshot.externalActions,
        callbacksEnabled: snapshot.callbacksEnabled,
        recallWebhookEnabled: snapshot.recallWebhookEnabled,
      },
    };

    if (dbStatus !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}
