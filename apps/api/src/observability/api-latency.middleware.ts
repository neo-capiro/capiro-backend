import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { meriDelegatedRequestId } from './meri-delegated-request-id.js';

const NAMESPACE = 'Capiro/ApiLatency';

@Injectable()
export class ApiLatencyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ApiLatencyMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const routePath = req.route?.path ? String(req.route.path) : req.path;
      const endpoint = `${req.method} ${routePath}`;

      this.logger.log(
        JSON.stringify({
          _aws: { CloudWatchMetrics: [{ Namespace: NAMESPACE }] },
          MetricName: 'api.endpoint_latency_ms',
          Value: durationMs,
          Unit: 'Milliseconds',
          Dimensions: [
            { Name: 'endpoint', Value: endpoint.slice(0, 255) },
            { Name: 'method', Value: req.method },
          ],
          Timestamp: new Date().toISOString(),
        }),
      );
      if (req.path.startsWith('/api/clio/tools/')) {
        this.logger.log(JSON.stringify({
          event: 'meri.delegated_http',
          requestId: meriDelegatedRequestId(req),
          endpoint: 'POST /api/clio/tools/:name',
          statusCode: res.statusCode,
          durationMs,
        }));
      }
    });

    next();
  }
}
