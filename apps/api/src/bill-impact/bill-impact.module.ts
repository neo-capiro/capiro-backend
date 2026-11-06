import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PortfolioAgentService } from '../clients/portfolio-agent.service.js';
import { BillImpactController } from './bill-impact.controller.js';
import { BillImpactService } from './bill-impact.service.js';
@Module({
  imports: [PrismaModule],
  controllers: [BillImpactController],
  providers: [BillImpactService, PortfolioAgentService],
})
export class BillImpactModule {}
