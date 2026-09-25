import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { VendorReferenceModule } from '../vendor-reference/vendor-reference.module.js';
import { BusinessDevelopmentController } from './business-development.controller.js';
import { BusinessDevelopmentService } from './business-development.service.js';
import { BusinessDevelopmentFlagGuard } from './business-development-flag.guard.js';
import { BizDevDossierService } from './bizdev-dossier.service.js';
import { BusinessDevelopmentDossierFlagGuard } from './bizdev-dossier.flag.guard.js';
import { BizDevBriefService } from './bizdev-brief.service.js';
import { BusinessDevelopmentBriefFlagGuard } from './bizdev-brief.flag.guard.js';
import { BusinessDevelopmentClaimValidationFlagGuard } from './bizdev-claim-validation.flag.guard.js';
import {
  BizDevJevService,
  BIZDEV_JEV_FACTORY,
  BIZDEV_JEV_REVIEW_HOOK,
  BIZDEV_JEV_SERVICE,
} from './bizdev-jev.service.js';
import { BizDevJevProviderFactory } from './bizdev-jev.factory.js';
import { BizDevMeriScopeService } from './bizdev-meri-scope.service.js';
import { BizDevWatchService } from './bizdev-watch.service.js';
import { BusinessDevelopmentWatchFlagGuard } from './bizdev-watch.flag.guard.js';

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
 *
 * Phase 3 adds the BizDevJevService (shadow/canary evaluation + redacted
 * decision traces) and the BizDevJevProviderFactory (shared @capiro/
 * meriv2-core config/client/provider reuse). Both are DARK by default:
 * nothing runs unless the env kill switch, per-task env mode, tenant
 * enrollment flags AND the shared task registry all allow it. No new route is
 * exposed; the trace table is service-internal.
 */
@Module({
  imports: [ClientsModule, IntelligenceModule, VendorReferenceModule],
  controllers: [BusinessDevelopmentController],
  providers: [
    BusinessDevelopmentService,
    BusinessDevelopmentFlagGuard,
    BizDevDossierService,
    BusinessDevelopmentDossierFlagGuard,
    BizDevBriefService,
    BusinessDevelopmentBriefFlagGuard,
    BusinessDevelopmentClaimValidationFlagGuard,
    BizDevJevProviderFactory,
    { provide: BIZDEV_JEV_FACTORY, useExisting: BizDevJevProviderFactory },
    BizDevJevService,
    { provide: BIZDEV_JEV_SERVICE, useExisting: BizDevJevService },
    { provide: BIZDEV_JEV_REVIEW_HOOK, useExisting: BizDevJevService },
    // Phase 4 server-only slice: bounded Meri prospect-conversation scope
    // resolution (exported for MeriModule; BD must never import Meri).
    BizDevMeriScopeService,
    // Phase 5: HTTP watch lifecycle + alert inbox (DB-only evaluator lives in
    // bizdev-watch-runner.ts, invoked exclusively by the scheduled verb).
    BizDevWatchService,
    BusinessDevelopmentWatchFlagGuard,
  ],
  exports: [
    BusinessDevelopmentService,
    BusinessDevelopmentFlagGuard,
    BizDevDossierService,
    BusinessDevelopmentDossierFlagGuard,
    BizDevBriefService,
    BusinessDevelopmentBriefFlagGuard,
    BusinessDevelopmentClaimValidationFlagGuard,
    BizDevJevService,
    BizDevMeriScopeService,
    BizDevWatchService,
    BusinessDevelopmentWatchFlagGuard,
  ],
})
export class BusinessDevelopmentModule {}
