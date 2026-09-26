import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ResearchPortfoliosController } from './research-portfolios.controller.js';
import { ResearchPortfoliosService } from './research-portfolios.service.js';
import { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [ResearchPortfoliosController],
  providers: [ResearchPortfoliosService, ResearchPortfolioRulesService],
  exports: [ResearchPortfoliosService, ResearchPortfolioRulesService],
})
export class ResearchPortfoliosModule {}
