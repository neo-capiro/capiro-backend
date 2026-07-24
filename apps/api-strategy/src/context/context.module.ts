import { Module } from '@nestjs/common';
import { ContextController } from './context.controller.js';
import { ContextDocumentsService } from './context-documents.service.js';
import { CurrentPlanExportService } from './current-plan-export.service.js';
import { VersioningService } from '../strategy/versioning.service.js';

/**
 * Stage D context module: context-pack document store (upload / supersession /
 * provenance locate) + the read-only current-plan projection. VersioningService
 * is stateless so provided locally (house parity with AgentsModule/MeriModule);
 * PrismaService + FlagsModule (guards) are @Global.
 */
@Module({
  controllers: [ContextController],
  providers: [ContextDocumentsService, CurrentPlanExportService, VersioningService],
})
export class ContextModule {}
