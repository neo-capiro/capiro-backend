import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { CapabilitiesModule } from '../../capabilities/capabilities.module.js';
import { OutreachAuditedStateRepository } from '../persistence/outreach-audited-state.repository.js';
import { OutreachStateRepository } from '../persistence/outreach-state.repository.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandEngineService } from '../services/outreach-command-engine.service.js';
import { OutreachCommandProposalService } from '../services/outreach-command-proposal.service.js';
import { OutreachV3StateController } from './outreach-v3-state.controller.js';
import { OutreachV3StateGuard } from './outreach-v3-state.guard.js';
import { OutreachV3ExceptionFilter } from './outreach-v3-exception.filter.js';

@Module({
  imports: [PrismaModule, CapabilitiesModule],
  controllers: [OutreachV3StateController],
  providers: [
    OutreachAuditedStateRepository,
    {
      provide: OutreachStateRepository,
      useExisting: OutreachAuditedStateRepository,
    },
    OutreachSessionService,
    OutreachCommandEngineService,
    OutreachCommandProposalService,
    OutreachV3StateGuard,
    OutreachV3ExceptionFilter,
  ],
  // Phase 3 deliberately receives only read/session + proposal creation/apply
  // seams. The command engine is not exported, so the reasoning module cannot
  // gain hidden direct mutation authority through Nest injection.
  exports: [OutreachSessionService, OutreachCommandProposalService],
})
export class OutreachV3StateModule {}
