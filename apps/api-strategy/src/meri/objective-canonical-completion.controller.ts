import { Body, Controller, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ObjectiveCanonicalCompletionService } from './objective-canonical-completion.service.js';

/** Fixed private URLs include main.ts's /strategy-api prefix. Caller input
 * selects only its original job. Neither a model payload nor a result locator
 * is accepted. The workload verifier remains default-unavailable. */
@Controller('internal/objective-canonical/generation-completions')
export class ObjectiveCanonicalCompletionController {
  constructor(private readonly completion: ObjectiveCanonicalCompletionService) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  complete(@Req() req: Request, @Body() body: unknown) { return this.completion.complete(req, body); }

  @Get(':generationJobId')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@Req() req: Request, @Param('generationJobId') id: string) { return this.completion.lookup(req, id); }
}
