import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { VendorReferenceModule } from '../vendor-reference/vendor-reference.module.js';
import { BusinessDevelopmentController } from './business-development.controller.js';
import { BusinessDevelopmentService } from './business-development.service.js';
import { BusinessDevelopmentFlagGuard } from './business-development-flag.guard.js';
import { BizDevDossierService } from './bizdev-dossier.service.js';
import { BusinessDevelopmentDossierFlagGuard } from './bizdev-dossier.flag.guard.js';

/**
 * Business Development Phase 1 — firm-private prospect pipeline.
 *
 * Composition reuses the AUTHORITATIVE services: ClientsService
 * (createInTransaction → slot entitlement + identical insert semantics) and
 * the IntelligenceModule resolution/prepopulation/SAM services (scheduled
 * after the conversion transaction commits, never inside it). Everything is
 * flag-gated per tenant by BusinessDevelopmentFlagGuard (default OFF, 404).
 *
 * Phase 2 adds the read-only dossier/candidate-search service + its own
 * additional guard (businessDevelopment.dossier.enabled, default OFF). The
 * VendorReferenceModule import brings in the exported VendorReferenceSamClient
 * for the dossier's at-most-one exact UEI/CAGE identity lookup.
 */
@Module({
  imports: [ClientsModule, IntelligenceModule, VendorReferenceModule],
  controllers: [BusinessDevelopmentController],
  providers: [
    BusinessDevelopmentService,
    BusinessDevelopmentFlagGuard,
    BizDevDossierService,
    BusinessDevelopmentDossierFlagGuard,
  ],
  exports: [
    BusinessDevelopmentService,
    BusinessDevelopmentFlagGuard,
    BizDevDossierService,
    BusinessDevelopmentDossierFlagGuard,
  ],
})
export class BusinessDevelopmentModule {}
