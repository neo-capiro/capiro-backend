import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { ObjectiveJobService } from './objective-job.service.js';

@Controller('internal/objective-generation')
@UseGuards(InternalServiceGuard)
export class ObjectiveJobController {
  constructor(private readonly jobs: ObjectiveJobService) {}
  @Post('current') @HttpCode(200)
  current(@Body() body: unknown, @Req() req: Request) { return this.jobs.current(body, req); }
  @Post('reads') @HttpCode(200)
  read(@Body() body: unknown, @Req() req: Request) { return this.jobs.read(body, req); }
}
