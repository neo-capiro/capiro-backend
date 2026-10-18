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

/** Deliberately unmounted. No key, issuer, audience, transport or route bypass. */
@Module({
  imports: [
    AuthModule,
    TenantModule,
    PrismaModule,
    RetainedReadAuthorityModule,
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
    { provide: RETAINED_PRINCIPAL_PORTS, useValue: null },
    { provide: RETAINED_FLORIDA_PROBE_VERIFIER, useValue: null },
  ],
})
export class RetainedPrincipalModule {}
