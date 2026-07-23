import { Controller, Get } from '@nestjs/common';

/**
 * Liveness endpoint. Mounted under the global `strategy-api` prefix (no
 * carve-out), so the effective path is `GET /strategy-api/health` — the ALB
 * target group and the container health check hit this. Ungated (no
 * TenantGuard) so a misconfigured Clerk env can't take the task out of
 * rotation.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { ok: true; service: 'api-strategy' } {
    return { ok: true, service: 'api-strategy' };
  }
}
