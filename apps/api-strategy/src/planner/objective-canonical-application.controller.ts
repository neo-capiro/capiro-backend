import { Body, Controller, Get, Header, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ObjectiveCanonicalApplicationService } from './objective-canonical-application.service.js';

/** Fixed private operation. This deliberately does not use InternalServiceGuard
 * or browser TenantGuard as an assertion of delegated workload authority. The
 * service's injected authority port rejects by default before DB access. */
@Controller('internal/objective-canonical/planner-applications')
export class ObjectiveCanonicalApplicationController {
  constructor(private readonly applications: ObjectiveCanonicalApplicationService) {}
  @Post()
  @Header('Cache-Control', 'private, no-store')
  prepare(@Req() request: Request, @Body() body: unknown) {
    return this.applications.prepare(request, body);
  }
  @Get(':applicationRequestId')
  @Header('Cache-Control', 'private, no-store')
  lookup(@Req() request: Request, @Param('applicationRequestId') id: string) {
    return this.applications.lookup(request, id);
  }
}
