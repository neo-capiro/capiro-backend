import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DefenseResearchController } from './defense-research.controller.js';
import { DefenseResearchService } from './defense-research.service.js';

import { DefenseSavedComparisonsService } from './defense-saved-comparisons.service.js';
import { DefenseSavedComparisonsController } from './defense-saved-comparisons.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [DefenseResearchController, DefenseSavedComparisonsController],
  providers: [DefenseResearchService, DefenseSavedComparisonsService],
  exports: [DefenseResearchService, DefenseSavedComparisonsService],
})
export class DefenseResearchModule {}
