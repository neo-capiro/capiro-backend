import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ResearchPortfoliosController } from './research-portfolios.controller.js';
import { ResearchPortfoliosService } from './research-portfolios.service.js';
import { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';
import { ResearchPortfolioReviewService } from './research-portfolio-review.service.js';
import { ResearchPortfolioImportService } from './research-portfolio-import.service.js';
import { DefenseResearchModule } from '../defense-research/defense-research.module.js';
import { ClientDocumentsModule } from '../client-documents/client-documents.module.js';
import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import { ResearchPortfolioOutputService } from './research-portfolio-output.service.js';
import { ResearchPortfolioMeriToolsService } from './research-portfolio-meri-tools.service.js';
import { ResearchPortfolioMeriScopeService } from './research-portfolio-meri-scope.service.js';
import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';
import { ResearchContextsController } from './research-contexts.controller.js';

@Module({
  imports: [PrismaModule, DefenseResearchModule, ClientDocumentsModule],
  controllers: [ResearchPortfoliosController, ResearchContextsController],
  providers: [ResearchPortfoliosService, ResearchPortfolioRulesService, ResearchPortfolioReviewService, ResearchPortfolioImportService, ResearchPortfolioChangesService, ResearchPortfolioAnalyticsService, ResearchPortfolioOutputService, ResearchPortfolioMeriToolsService, ResearchPortfolioMeriScopeService, ResearchPortfolioPhase11Service],
  exports: [ResearchPortfoliosService, ResearchPortfolioRulesService, ResearchPortfolioReviewService, ResearchPortfolioImportService, ResearchPortfolioChangesService, ResearchPortfolioAnalyticsService, ResearchPortfolioOutputService, ResearchPortfolioMeriToolsService, ResearchPortfolioMeriScopeService, ResearchPortfolioPhase11Service],
})
export class ResearchPortfoliosModule {}
