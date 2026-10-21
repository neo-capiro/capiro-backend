import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { applicationAuthorityThrottleKey } from '../tenant/tenant-context.middleware.js';

/** Authority POSTs share the existing limits by verified user. All other
 * traffic retains the framework's IP tracker and existing limit policy. */
@Injectable()
export class CapiroThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return applicationAuthorityThrottleKey(req as Request) ?? super.getTracker(req);
  }
}
