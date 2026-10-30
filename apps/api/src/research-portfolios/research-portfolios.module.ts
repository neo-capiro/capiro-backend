import { EngagementModule } from '../engagement/engagement.module.js';
import { BrandingModule } from '../branding/branding.module.js';
import { ResearchPortfolioInstitutionalService } from './research-portfolio-institutional.service.js';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ResearchPortfoliosController } from './research-portfolios.controller.js';
import { ResearchPortfoliosService } from './research-portfolios.service.js';
import { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';
import { ResearchPortfolioReviewService } from './research-portfolio-review.service.js';
import { ResearchPortfolioImportService } from './research-portfolio-import.service.js';
import { DefenseResearchModule } from '../defense-research/defense-research.module.js';
import { ClientDocumentsModule } from '../client-documents/client-documents.module.js';
import { ResearchPortfolioWatchWorkerService } from './research-portfolio-watch-worker.service.js';
import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import { ResearchPortfolioOutputService } from './research-portfolio-output.service.js';
import { ResearchPortfolioMeriToolsService } from './research-portfolio-meri-tools.service.js';
import { ResearchPortfolioMeriScopeService } from './research-portfolio-meri-scope.service.js';
import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';
import { ResearchContextsController } from './research-contexts.controller.js';
import { ResearchPortfolioSharePayloadService } from './research-portfolio-share-payload.service.js';
import { ResearchPortfolioShareDispatchController } from './research-portfolio-share.controller.js';
import { ResearchPortfolioShareService } from './research-portfolio-share.service.js';
import { ResearchPortfolioBillsService } from './research-portfolio-bills.service.js';
import {
  ResearchPortfolioShareController,
  ResearchPortfolioShareAdminController,
  ResearchPortfolioSharePublicController,
} from './research-portfolio-share.controller.js';

@Module({
  imports: [
    EngagementModule,
    PrismaModule,
    DefenseResearchModule,
    ClientDocumentsModule,
    BrandingModule,
  ],
  controllers: [
    ResearchPortfoliosController,
    ResearchContextsController,
    ResearchPortfolioShareController,
    ResearchPortfolioShareAdminController,
    ResearchPortfolioSharePublicController,
    ResearchPortfolioShareDispatchController,
  ],
  providers: [
    ResearchPortfolioInstitutionalService,
    ResearchPortfolioWatchWorkerService,
    ResearchPortfoliosService,
    ResearchPortfolioRulesService,
    ResearchPortfolioReviewService,
    ResearchPortfolioImportService,
    ResearchPortfolioChangesService,
    ResearchPortfolioAnalyticsService,
    ResearchPortfolioOutputService,
    ResearchPortfolioMeriToolsService,
    ResearchPortfolioMeriScopeService,
    ResearchPortfolioPhase11Service,
    ResearchPortfolioShareService,
    ResearchPortfolioSharePayloadService,
    ResearchPortfolioBillsService,
  ],
  exports: [
    ResearchPortfolioInstitutionalService,
    ResearchPortfolioWatchWorkerService,
    ResearchPortfoliosService,
    ResearchPortfolioRulesService,
    ResearchPortfolioReviewService,
    ResearchPortfolioImportService,
    ResearchPortfolioChangesService,
    ResearchPortfolioAnalyticsService,
    ResearchPortfolioOutputService,
    ResearchPortfolioMeriToolsService,
    ResearchPortfolioMeriScopeService,
    ResearchPortfolioPhase11Service,
    ResearchPortfolioBillsService,
  ],
})
export class ResearchPortfoliosModule {}
