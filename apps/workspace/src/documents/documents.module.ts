import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
