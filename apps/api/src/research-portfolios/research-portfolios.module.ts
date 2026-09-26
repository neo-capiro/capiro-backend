import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ResearchPortfoliosController } from './research-portfolios.controller.js';
import { ResearchPortfoliosService } from './research-portfolios.service.js';
import { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';
import { ResearchPortfolioReviewService } from './research-portfolio-review.service.js';
import { ResearchPortfolioImportService } from './research-portfolio-import.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [ResearchPortfoliosController],
  providers: [ResearchPortfoliosService, ResearchPortfolioRulesService, ResearchPortfolioReviewService, ResearchPortfolioImportService],
  exports: [ResearchPortfoliosService, ResearchPortfolioRulesService, ResearchPortfolioReviewService, ResearchPortfolioImportService],
})
export class ResearchPortfoliosModule {}
