import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PortfolioAgentService } from '../clients/portfolio-agent.service.js';
import { ImpactController } from './impact.controller.js';
import { ImpactService } from './impact.service.js';
import { ImpactRepository } from './impact.repository.js';
import { ImpactEvidenceService } from './impact-evidence.service.js';
import { ImpactAnalysisService } from './impact-analysis.service.js';
import { ImpactRefreshService } from './impact-refresh.service.js';
import { ImpactRefreshRepository } from './impact-refresh.repository.js';

@Module({
  imports: [PrismaModule],
  controllers: [ImpactController],
  providers: [
    ImpactService,
    ImpactRepository,
    ImpactEvidenceService,
    ImpactAnalysisService,
    PortfolioAgentService,
    ImpactRefreshService,
    ImpactRefreshRepository,
  ],
  exports: [ImpactService, ImpactRefreshService, ImpactRefreshRepository],
})
export class ImpactModule {}
