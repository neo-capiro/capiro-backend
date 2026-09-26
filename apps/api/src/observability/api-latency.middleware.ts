import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

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
    });

    next();
  }
}
