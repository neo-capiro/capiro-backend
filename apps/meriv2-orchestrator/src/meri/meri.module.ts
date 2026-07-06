import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriController } from './meri.controller.js';
import { MeriRegistryService } from './meri-registry.service.js';
import { MeriContextResolver } from './meri-context.resolver.js';
import { ApiClientContextRepo } from './api-client-context.repo.js';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { ApiApprovalRepo } from './api-approval.repo.js';
import { InEditorController } from './in-editor/in-editor.controller.js';
import { InEditorAssistantService } from './in-editor/in-editor-assistant.service.js';

/**
 * Hosts the MeriV2 tool registry over HTTP at `/meri-api/tools/*` plus the
 * in-editor assistant surface at `/meri-api/in-editor-assistant`. Thin: all
 * reasoning lives in `@capiro/meriv2-core`; this module wires the data adapters
 * (the api-delegating client-context repo + the generic tool executor), the
 * in-editor loop, and the tenant-scoped invocation path.
 */
@Module({
  controllers: [MeriController, InEditorController],
  providers: [
    PrismaService,
    MeriContextResolver,
    ApiClientContextRepo,
    ApiToolExecutorRepo,
    ApiApprovalRepo,
    MeriRegistryService,
    InEditorAssistantService,
  ],
})
export class MeriModule {}
