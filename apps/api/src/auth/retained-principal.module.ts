import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ResearchPortfoliosService } from '../research-portfolios/research-portfolios.service.js';
import { ResearchPortfolioChangesService } from '../research-portfolios/research-portfolio-changes.service.js';
import { AuthModule } from './auth.module.js';
import { RetainedReadAuthorityModule } from './retained-read-authority.module.js';
import {
  RetainedPrincipalDataController,
  RetainedPrincipalIssuerController,
} from './retained-principal.controller.js';
import {
  RETAINED_PRINCIPAL_PORTS,
  RetainedPrincipalService,
} from './retained-principal.service.js';
import {
  RETAINED_FLORIDA_PROBE_VERIFIER,
  RetainedFloridaCurrentController,
} from './retained-florida-current.controller.js';
import {
  RETAINED_TRUST,
  RetainedTrustModule,
  createRetainedFloridaProbeVerifier,
  createRetainedPrincipalPorts,
} from './retained-trust.js';

/** Mounted by AppModule. Ports come from the validated retained trust pins and stay
 * null (every route 503) unless RETAINED_READS_ENABLED=true. The signed data and
 * Florida current routes are admitted past the Bearer-only tenant middleware only
 * by their exact path, POST method and signed authorization scheme. */
@Module({
  imports: [
    AuthModule,
    TenantModule,
    PrismaModule,
    RetainedReadAuthorityModule,
    RetainedTrustModule,
  ],
  controllers: [
    RetainedPrincipalIssuerController,
    RetainedPrincipalDataController,
    RetainedFloridaCurrentController,
  ],
  providers: [
    RetainedPrincipalService,
    ResearchPortfoliosService,
    ResearchPortfolioChangesService,
    { provide: RETAINED_PRINCIPAL_PORTS, useFactory: createRetainedPrincipalPorts, inject: [RETAINED_TRUST] },
    { provide: RETAINED_FLORIDA_PROBE_VERIFIER, useFactory: createRetainedFloridaProbeVerifier, inject: [RETAINED_TRUST] },
  ],
})
export class RetainedPrincipalModule {}
