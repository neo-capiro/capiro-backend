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
import {
  NATIVE_GENERATION_TURN,
  type NativeGenerationTurnPort,
} from '../document-agent/native-generation.bridge.js';
import { nativeGenerationClientFromEnvironment } from '../document-agent/native-generation-conversation.client.js';
import { NativeIntakeAdapter } from './native-intake.adapter.js';

/**
 * QuickDraftModule — the two-step Max draft flow (PR #964).
 *
 * Registers both the old endpoint (temporarily behind the flag) and the new
 * aggregate intake endpoint. The intake endpoint's durable run is drafted by the
 * approved greenfield Meri native conversation owner through
 * {@link NativeIntakeAdapter} — the SAME owner, injection token and closed wire
 * protocol the five Workspace document-agent phases use, declared here for this
 * module's own caller. It is not a second transport: when the deployment does
 * not configure the owner, the token resolves to null and the run records an
 * explicit owner-unavailable refusal instead of falling back to a removed
 * provider path.
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
    {
      provide: NATIVE_GENERATION_TURN,
      useFactory: (): NativeGenerationTurnPort | null => nativeGenerationClientFromEnvironment(),
    },
    NativeIntakeAdapter,
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
   * every 5 seconds. A durable intake run is dispatched by its own attended
   * caller (the intake route, or a status read that holds current access), so
   * the poller leaves those runs to that caller.
   */
  async onModuleInit() {
    this.logger.log('Starting durable generation run worker poller');
    this.runWorker.startPoller(5_000);
  }
}
