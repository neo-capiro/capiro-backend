import { Module } from '@nestjs/common';
import { LegalService } from './legal.service.js';

/**
 * Versioned legal docs (ToS + plan-variant SA) and consent capture. The
 * `seed-legal-docs` task-runner verb seeds the counsel-pending drafts.
 */
@Module({
  providers: [LegalService],
  exports: [LegalService],
})
export class LegalModule {}
