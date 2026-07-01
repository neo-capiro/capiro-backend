import { Controller, Get } from '@nestjs/common';

/**
 * Bare `/health` endpoint, excluded from the global `intel-api` prefix in
 * main.ts. The ALB target group hits this for liveness; keeping it ungated
 * (no auth, no tenant) means a misconfigured Clerk env can't take the task
 * out of rotation.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { ok: true; service: 'intel-api' } {
    return { ok: true, service: 'intel-api' };
  }
}
