import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DefenseResearchController } from './defense-research.controller.js';
import { DefenseResearchService } from './defense-research.service.js';
import { DefenseBudgetEvidenceLocatorService } from './defense-budget-evidence-locator.service.js';

import { DefenseSavedComparisonsService } from './defense-saved-comparisons.service.js';
import { DefenseSavedComparisonsController } from './defense-saved-comparisons.controller.js';
import { ProcurementMoneyFlowController, ProcurementHubController } from './procurement-money-flow.controller.js';
import { ProcurementMoneyFlowService } from './procurement-money-flow.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [DefenseResearchController, DefenseSavedComparisonsController, ProcurementMoneyFlowController, ProcurementHubController],
  providers: [
    DefenseResearchService,
    DefenseSavedComparisonsService,
    DefenseBudgetEvidenceLocatorService,
    ProcurementMoneyFlowService,
  ],
  exports: [DefenseResearchService, DefenseSavedComparisonsService],
})
export class DefenseResearchModule {}
