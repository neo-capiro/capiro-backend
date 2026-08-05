import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

/**
 * Dedicated health endpoint for the engagement-api process.
 *
 * Route: GET /health (excluded from the /api global prefix)
 *
 * Response shape:
 *   {
 *     "status": "ok",
 *     "service": "engagement-api",
 *     "releaseSha": "UNVERIFIED",
 *     "time": "<ISO-8601>",
 *     "database": { "status": "ok" },
 *     "runtime": {
 *       "processMode": "shadow",
 *       "backgroundOwner": "disabled",
 *       "externalActions": "disabled",
 *       "callbacksEnabled": false,
 *       "recallWebhookEnabled": false
 *     }
 *   }
 *
 * Must never include DB host, DB name, secret ARNs, credentials, provider
 * keys, tenant IDs, or queue contents.
 */
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
    } catch (err) {
      this.logger.warn(`Database health check failed: ${(err as Error).message}`);
      dbStatus = 'unavailable';
    }

    const snapshot = this.runtimePolicy.snapshot();
    const releaseSha = this.config.get<string>('RELEASE_SHA') ?? 'UNVERIFIED';

    const body = {
      status: dbStatus === 'ok' ? 'ok' : 'unavailable',
      service: 'engagement-api',
      releaseSha,
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

    if (dbStatus !== 'ok') {
      throw new ServiceUnavailableException(body);
    }

    return body;
  }
}
