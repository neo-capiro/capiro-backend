import { Module } from '@nestjs/common';
import { SourceDataModule } from '../sourcedata/source-data.module.js';
import { BillDossierController } from './bill-dossier.controller.js';
import { BillDossierService } from './bill-dossier.service.js';
import { Bill360FeatureGuard } from './bill-360.guard.js';

/**
 * Bill 360 dossier module (plan §1.2). Imports SourceDataModule for the
 * read-only SourceDataRepository (congress rail) + StateSourceDataRepository
 * (state rail). PrismaService and FeatureFlagService are @Global so they inject
 * without an explicit import. The Bill360FeatureGuard is provided here (it needs
 * FeatureFlagService) and applied at the controller.
 */
@Module({
  imports: [SourceDataModule],
  controllers: [BillDossierController],
  providers: [BillDossierService, Bill360FeatureGuard],
  exports: [BillDossierService],
})
export class BillDossierModule {}
