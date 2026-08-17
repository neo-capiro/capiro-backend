import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export interface DefenseRequestContext {
  readonly requestId: string;
  readonly traceparent: string | null;
  readonly startedAtMs: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    defenseContext?: DefenseRequestContext;
  }
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = headerString(req.headers['x-request-id']) ?? randomUUID();
    const traceparent = headerString(req.headers.traceparent);

    req.defenseContext = {
      requestId,
      traceparent,
      startedAtMs: Date.now(),
    };

    res.setHeader('x-request-id', requestId);
    next();
  }
}
