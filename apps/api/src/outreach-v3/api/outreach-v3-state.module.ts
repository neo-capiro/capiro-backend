import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { CapabilitiesModule } from '../../capabilities/capabilities.module.js';
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
    OutreachStateRepository,
    OutreachSessionService,
    OutreachCommandEngineService,
    OutreachCommandProposalService,
    OutreachV3StateGuard,
    OutreachV3ExceptionFilter,
  ],
})
export class OutreachV3StateModule {}
