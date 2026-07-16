import { Module } from '@nestjs/common';
import { DraftContextController } from './context.controller.js';
import { ContextService } from './context.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [DraftContextController],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
