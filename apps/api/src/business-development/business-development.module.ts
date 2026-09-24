import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { BusinessDevelopmentController } from './business-development.controller.js';
import { BusinessDevelopmentService } from './business-development.service.js';
import { BusinessDevelopmentFlagGuard } from './business-development-flag.guard.js';

/**
 * Business Development Phase 1 — firm-private prospect pipeline.
 *
 * Composition reuses the AUTHORITATIVE services: ClientsService
 * (createInTransaction → slot entitlement + identical insert semantics) and
 * the IntelligenceModule resolution/prepopulation/SAM services (scheduled
 * after the conversion transaction commits, never inside it). Everything is
 * flag-gated per tenant by BusinessDevelopmentFlagGuard (default OFF, 404).
 */
@Module({
  imports: [ClientsModule, IntelligenceModule],
  controllers: [BusinessDevelopmentController],
  providers: [BusinessDevelopmentService, BusinessDevelopmentFlagGuard],
  exports: [BusinessDevelopmentService, BusinessDevelopmentFlagGuard],
})
export class BusinessDevelopmentModule {}
