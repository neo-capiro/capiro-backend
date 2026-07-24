import { Module } from '@nestjs/common';
import { BudgetPackagesController } from './budget-packages.controller.js';
import { BudgetPackagesService } from './budget-packages.service.js';

/**
 * Budget Package read module (Release R3, plan §3.4). PrismaService is @Global so it
 * injects without an explicit import. Read-only: this module never writes budget
 * data — the curated loader (scripts/load-defense-budget-package.ts) and the
 * parsers own every write.
 */
@Module({
  controllers: [BudgetPackagesController],
  providers: [BudgetPackagesService],
  exports: [BudgetPackagesService],
})
export class BudgetPackagesModule {}
