import { Body, Controller, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ObjectiveCanonicalProducerService } from './objective-canonical-producer.service.js';

/** Effective URLs include main.ts's fixed /strategy-api global prefix. These
 * methods authenticate through the named workload owner, default unavailable;
 * browser TenantGuard/shared secrets cannot activate these private operations. */
@Controller('internal/objective-canonical')
export class ObjectiveCanonicalProducerController {
  constructor(private readonly producer: ObjectiveCanonicalProducerService) {}
  @Post('generation-admissions')
  @Header('Cache-Control', 'private, no-store')
  capture(@Req() req: Request, @Body() body: unknown) { return this.producer.capture(req, body); }
  @Get('generation-admissions/:generationJobId')
  @Header('Cache-Control', 'private, no-store')
  read(@Req() req: Request, @Param('generationJobId') id: string) { return this.producer.readAdmission(req, id); }
  @Post('generation-acceptances')
  @Header('Cache-Control', 'private, no-store')
  accept(@Req() req: Request, @Body() body: unknown) { return this.producer.accept(req, body); }
  @Post('generation-producer/admit')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  admit(@Req() req: Request, @Body() body: unknown) { return this.producer.admit(req, body); }
}
