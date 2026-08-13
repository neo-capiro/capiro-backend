import { Module } from '@nestjs/common';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { TemplateStudioController } from './template-studio.controller.js';
import { TemplateStudioService } from './template-studio.service.js';
import { TemplateValidator } from './template-validator.js';

/**
 * Template Studio module. PrismaService is global; CollaboratorsService is
 * scoped to CollaboratorsModule and must be imported explicitly (same pattern
 * as CommentsModule, ContextModule, DeliveryModule, DocumentAgentModule).
 */
@Module({
  imports: [CollaboratorsModule],
  controllers: [TemplateStudioController],
  providers: [TemplateStudioService, TemplateValidator],
  exports: [TemplateStudioService, TemplateValidator],
})
export class TemplateStudioModule {}
