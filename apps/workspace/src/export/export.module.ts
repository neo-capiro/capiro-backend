import { Module } from '@nestjs/common';
import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { VersionsModule } from '../versions/versions.module.js';
import { SavedSnapshotExportService } from './saved-snapshot-export.service.js';

@Module({
  imports: [CollaboratorsModule, VersionsModule],
  controllers: [ExportController],
  providers: [ExportService, SavedSnapshotExportService],
  exports: [ExportService],
})
export class ExportModule {}
