import { Module } from '@nestjs/common';
import { AiCredentialService } from '../generation/ai-credential.service.js';
import { DirectoryBridgeClient } from './directory-bridge.client.js';
import { HillDayContextService } from './hillday-context.service.js';
import { HillDayDocumentService } from './hillday-document.service.js';
import { HillDayExportService } from './hillday-export.service.js';
import { HillDayGenerationService } from './hillday-generation.service.js';
import { HillDayResolutionService } from './hillday-resolution.service.js';
import { HillDaySourceService } from './hillday-source.service.js';
import { HillDayController, HillDayFileController } from './hillday.controller.js';

/**
 * Hill Day workflow (Workspace vNext, 2026-09): six-step wizard backend +
 * document editor API. New build; nothing from the legacy draft engine is
 * reused except the tenant-scoped AI credential resolver.
 */
@Module({
  controllers: [HillDayController, HillDayFileController],
  providers: [
    HillDaySourceService,
    DirectoryBridgeClient,
    HillDayResolutionService,
    HillDayContextService,
    HillDayGenerationService,
    HillDayDocumentService,
    HillDayExportService,
    AiCredentialService,
  ],
})
export class HillDayModule {}
