import { Module } from '@nestjs/common';
import { VersionsController } from './versions.controller.js';
import { VersionsService } from './versions.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [VersionsController],
  providers: [VersionsService],
  exports: [VersionsService],
})
export class VersionsModule {}
