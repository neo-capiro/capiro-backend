import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { CapabilitiesModule } from '../../capabilities/capabilities.module.js';
import { OutreachAuditedStateRepository } from '../persistence/outreach-audited-state.repository.js';
import { OutreachStateRepository } from '../persistence/outreach-state.repository.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandEngineService } from '../services/outreach-command-engine.service.js';
import { OutreachCommandProposalService } from '../services/outreach-command-proposal.service.js';
import { OutreachStateVersionGuardService } from '../services/outreach-state-version-guard.service.js';
import { OutreachUserDecisionEventService } from '../services/outreach-user-decision-event.service.js';
import { OutreachTemplateController } from '../templates/outreach-template.controller.js';
import { OutreachTemplateRepository } from '../templates/outreach-template.repository.js';
import { OutreachTemplateService } from '../templates/outreach-template.service.js';
import { StarterTemplateSeeder } from '../templates/starter-template-seeder.js';
import { OutreachV3StateController } from './outreach-v3-state.controller.js';
import { OutreachV3StateGuard } from './outreach-v3-state.guard.js';
import { OutreachV3ExceptionFilter } from './outreach-v3-exception.filter.js';
import { ClientObjectivesModule } from '../../clients/objectives/objectives.module.js';

@Module({
  imports: [PrismaModule, CapabilitiesModule, ClientObjectivesModule],
  controllers: [OutreachV3StateController, OutreachTemplateController],
  providers: [
    OutreachAuditedStateRepository,
    {
      provide: OutreachStateRepository,
      useExisting: OutreachAuditedStateRepository,
    },
    OutreachSessionService,
    OutreachCommandEngineService,
    OutreachCommandProposalService,
    OutreachStateVersionGuardService,
    OutreachUserDecisionEventService,
    OutreachTemplateRepository,
    OutreachTemplateService,
    StarterTemplateSeeder,
    OutreachV3StateGuard,
    OutreachV3ExceptionFilter,
  ],
  // Later reasoning receives only bounded session/proposal/version-check seams.
  // The command engine, template compiler and raw repositories are not exported,
  // so no model layer can gain Campaign Spec or template publication authority
  // through Nest injection.
  exports: [
    OutreachSessionService,
    OutreachCommandProposalService,
    OutreachStateVersionGuardService,
    OutreachUserDecisionEventService,
  ],
})
export class OutreachV3StateModule {}
