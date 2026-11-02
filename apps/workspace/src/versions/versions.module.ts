import { Module } from '@nestjs/common';
import { VersionsController } from './versions.controller.js';
import { VersionsService } from './versions.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { ProspectPublicationController } from './prospect-publication.controller.js';
import { ProspectPublicationService } from './prospect-publication.service.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [VersionsController, ProspectPublicationController],
  providers: [VersionsService, ProspectPublicationService],
  exports: [VersionsService],
})
export class VersionsModule {}
