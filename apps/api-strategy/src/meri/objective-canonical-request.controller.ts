import { Body, Controller, Get, Header, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ObjectiveCanonicalRequestService } from './objective-canonical-request.service.js';

@Controller('internal/objective-canonical/generation-requests')
export class ObjectiveCanonicalRequestController {
  constructor(private readonly requests: ObjectiveCanonicalRequestService) {}
  // Nest POST 201, effective URL includes main.ts's /strategy-api prefix.
  @Post()
  @Header('Cache-Control', 'private, no-store')
  publish(@Req() request: Request, @Body() body: unknown) { return this.requests.publish(request, body); }
  @Get(':generationJobId')
  @Header('Cache-Control', 'private, no-store')
  lookup(@Req() request: Request, @Param('generationJobId') id: string) { return this.requests.lookup(request, id); }
}
