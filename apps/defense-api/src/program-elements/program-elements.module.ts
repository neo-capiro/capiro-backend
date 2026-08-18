import { Module } from '@nestjs/common';
import { AuthModule } from '@capiro/auth';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DefenseMemberResolverGuard } from '../roles/defense-member-resolver.guard.js';
import { ProgramElementController } from './program-element.controller.js';
import { BudgetLinesController } from './budget-lines.controller.js';
import { ProgramsController } from './programs.controller.js';
import { ProgramElementReadService } from './program-element-read.service.js';
import { ProgramElementDataIssueService } from './program-element-data-issue.service.js';
import { BudgetLinesReadService } from './budget-lines-read.service.js';
import { ProgramsService } from './programs.service.js';

/**
 * Session 3 — full Program Elements / Budget Lines / Programs surface.
 * Registered dark in AppModule; no production traffic is routed here.
 *
 * Each controller applies its own guard chain
 * (TenantGuard -> DefenseMemberResolverGuard -> RolesGuard) via
 * @UseGuards(...) directly, so the real per-request order is exactly that —
 * verified Clerk session, then resolved Capiro membership, then role check.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ProgramElementController, BudgetLinesController, ProgramsController],
  providers: [
    ProgramElementReadService,
    ProgramElementDataIssueService,
    BudgetLinesReadService,
    ProgramsService,
    DefenseMemberResolverGuard,
  ],
})
export class ProgramElementsModule {}
