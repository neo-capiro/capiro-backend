import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { AiCredentialService } from '../generation/ai-credential.service.js';
import { DirectoryBridgeClient } from './directory-bridge.client.js';
import { HillDayContextService } from './hillday-context.service.js';
import { HillDayDocumentService } from './hillday-document.service.js';
import { HillDayExportService } from './hillday-export.service.js';
import { HillDayGenerationService } from './hillday-generation.service.js';
import { HillDayJobWorkerService } from './hillday-job-worker.service.js';
import { HillDayResolutionService } from './hillday-resolution.service.js';
import { HillDaySourceService } from './hillday-source.service.js';
import { HillDayController } from './hillday.controller.js';
import { HillDayFileController } from './hillday-file.controller.js';

/**
 * Hill Day workflow (Workspace vNext, 2026-09): six-step wizard backend +
 * document editor API. New build; nothing from the legacy draft engine is
 * reused except the tenant-scoped AI credential resolver.
 */
@Module({
  imports: [CollaboratorsModule],
  controllers: [HillDayController, HillDayFileController],
  providers: [
    HillDaySourceService,
    DirectoryBridgeClient,
    HillDayResolutionService,
    HillDayContextService,
    HillDayGenerationService,
    HillDayJobWorkerService,
    HillDayDocumentService,
    HillDayExportService,
    AiCredentialService,
  ],
})
export class HillDayModule implements OnModuleInit {
  private readonly logger = new Logger(HillDayModule.name);

  constructor(private readonly jobWorker: HillDayJobWorkerService) {}

  /**
   * Start the durable Hill Day job worker poller. Claims and processes queued
   * generation jobs every 5 seconds — the same binding the accepted quick-draft
   * owner uses for its own durable run worker. Without this binding the job row
   * is created `queued` and nothing durable ever claims it.
   */
  onModuleInit(): void {
    this.logger.log('Starting durable Hill Day job worker poller');
    this.jobWorker.startPoller(5_000);
  }
}
