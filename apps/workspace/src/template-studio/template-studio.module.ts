import { Module } from '@nestjs/common';
import { TemplateStudioController } from './template-studio.controller.js';
import { TemplateStudioService } from './template-studio.service.js';
import { TemplateValidator } from './template-validator.js';

/**
 * Template Studio module. Depends on PrismaModule (global PrismaService) and
 * CollaboratorsModule (CollaboratorsService) via their exported providers —
 * the workspace engine wires both globally, so they resolve without explicit
 * imports here (matching TemplatesModule/CollaboratorsModule conventions).
 */
@Module({
  controllers: [TemplateStudioController],
  providers: [TemplateStudioService, TemplateValidator],
  exports: [TemplateStudioService, TemplateValidator],
})
export class TemplateStudioModule {}
