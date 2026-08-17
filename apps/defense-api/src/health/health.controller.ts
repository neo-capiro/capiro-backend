import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service.js';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('healthz')
  healthz() {
    return this.health.liveness();
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: true }) response: Response) {
    const result = await this.health.readiness();
    response.status(result.httpStatus);
    return result;
  }
}
