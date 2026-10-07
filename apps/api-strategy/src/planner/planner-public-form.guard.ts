import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { PlannerService } from './planner.service.js';

/** Reject unavailable/revoked capabilities before buffering multipart files.
 * The actual submission checks access and quotas again under the tenant lock. */
@Injectable()
export class PlannerPublicFormGuard implements CanActivate {
  constructor(private readonly planner: PlannerService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ params: { token: string } }>();
    await this.planner.publicForm(request.params.token);
    return true;
  }
}
