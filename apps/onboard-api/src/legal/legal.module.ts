import { Module } from '@nestjs/common';
import { LegalService } from './legal.service.js';
import { SignedPdfService } from './signed-pdf.service.js';

/**
 * Versioned legal docs (ToS + plan-variant SA), consent capture, and the
 * signed Certificate-of-Completion PDF builder. The `seed-legal-docs`
 * task-runner verb seeds the active document versions.
 */
@Module({
  providers: [LegalService, SignedPdfService],
  exports: [LegalService, SignedPdfService],
})
export class LegalModule {}
