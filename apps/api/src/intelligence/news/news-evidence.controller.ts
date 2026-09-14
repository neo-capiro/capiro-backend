import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalServiceGuard } from '../../auth/internal-service.guard.js';
import { NewsEvidenceService } from './news-evidence.service.js';
@Controller('internal/legiwatch/news')
@UseGuards(InternalServiceGuard)
export class NewsEvidenceController {
  constructor(readonly evidence: NewsEvidenceService) {}
  @Post('page') page(@Body() input: Record<string, unknown>) {
    return this.evidence.monitoringPage(input);
  }
}
