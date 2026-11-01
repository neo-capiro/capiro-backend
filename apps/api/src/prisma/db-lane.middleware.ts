import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { mountedRequestPath } from '../auth/mounted-request-path.js';
import { isAuthorityRequestPath, runInDbLane } from './db-lane.js';

/**
 * Marks Meri's conversation-authority routes so every transaction helper call
 * on the request, including the tenant-context middleware's own membership
 * resolution that runs after this, opens on the dedicated authority pool.
 * Registered ahead of TenantContextMiddleware in AppModule; it has no
 * dependencies and never rejects a request.
 */
@Injectable()
export class DbLaneMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    if (isAuthorityRequestPath(mountedRequestPath(req))) {
      runInDbLane('authority', () => next());
      return;
    }
    next();
  }
}
