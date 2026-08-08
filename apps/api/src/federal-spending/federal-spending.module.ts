import { Module } from '@nestjs/common';
import { FederalSpendingController } from './federal-spending.controller.js';
import { FederalSpendingService } from './federal-spending.service.js';
import { FederalMarketController } from './federal-market.controller.js';
import { FederalMarketGeographyService } from './federal-market-geography.service.js';
import { FederalMarketMeriToolsService } from './federal-market-meri-tools.service.js';
import { FederalMarketService } from './federal-market.service.js';

@Module({
  controllers: [FederalSpendingController, FederalMarketController],
  providers: [
    FederalSpendingService,
    FederalMarketService,
    FederalMarketGeographyService,
    FederalMarketMeriToolsService,
  ],
  exports: [
    FederalSpendingService,
    FederalMarketService,
    FederalMarketGeographyService,
    FederalMarketMeriToolsService,
  ],
})
export class FederalSpendingModule {}
