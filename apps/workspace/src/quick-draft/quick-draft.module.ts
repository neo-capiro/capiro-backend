import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { ContextModule } from '../context/context.module.js';
import { WorkspaceReasoningModule } from '../workspace-reasoning/workspace-reasoning.module.js';
import { GenerationModule } from '../generation/generation.module.js';
import { VersionsModule } from '../versions/versions.module.js';
import { QuickDraftController } from './quick-draft.controller.js';
import { TwoStepDraftController } from './two-step-draft.controller.js';
import { QuickDraftService } from './quick-draft.service.js';
import { IntakeService } from './intake.service.js';
import { GenerationRunWorkerService } from './generation-run-worker.service.js';
import {
  SourceResolverService,
  StubAttachmentResolver,
  ATTACHMENT_RESOLVER,
} from './source-resolver.service.js';
import { TwoStepDraftFlagsService } from './two-step-draft-flags.service.js';

/**
 * QuickDraftModule — the two-step Max draft flow (PR #964).
 *
 * Registers both the old endpoint (temporarily behind the flag) and the new
 * aggregate intake endpoint. The new endpoint funnels through the canonical
 * GenerationService, not a parallel generation path.
 */
@Module({
  imports: [
    CollaboratorsModule,
    ContextModule,
    WorkspaceReasoningModule,
    GenerationModule,
    VersionsModule,
  ],
  controllers: [QuickDraftController, TwoStepDraftController],
  providers: [
    QuickDraftService,
    IntakeService,
    GenerationRunWorkerService,
    SourceResolverService,
    { provide: ATTACHMENT_RESOLVER, useClass: StubAttachmentResolver },
    TwoStepDraftFlagsService,
  ],
  exports: [
    QuickDraftService,
    TwoStepDraftFlagsService,
    SourceResolverService,
  ],
})
export class QuickDraftModule implements OnModuleInit {
  private readonly logger = new Logger(QuickDraftModule.name);

  constructor(private readonly runWorker: GenerationRunWorkerService) {}

  /**
   * Start the durable run worker poller. Claims and processes queued runs
   * every 5 seconds. The worker is also triggered manually after intake.
   */
  async onModuleInit() {
    this.logger.log('Starting durable generation run worker poller');
    this.runWorker.startPoller(5_000);
  }
}
