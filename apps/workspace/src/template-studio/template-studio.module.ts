import { Module } from '@nestjs/common';
import { TemplateStudioController } from './template-studio.controller.js';
import { TemplateStudioService } from './template-studio.service.js';
import { ThemeStudioController } from './theme-studio.controller.js';
import { ThemeStudioService } from './theme-studio.service.js';
import { BrandAssetController } from './brand-asset.controller.js';
import { BrandAssetService } from './brand-asset.service.js';
import { BrandAssetAttachmentClient } from './brand-asset-attachment.client.js';
import { TemplateValidator } from './template-validator.js';

/** Template Studio owns catalog/version policy. PrismaService is global. */
@Module({
  controllers: [TemplateStudioController, ThemeStudioController, BrandAssetController],
  providers: [
    TemplateStudioService, ThemeStudioService, BrandAssetService,
    BrandAssetAttachmentClient, TemplateValidator,
  ],
  exports: [TemplateStudioService, ThemeStudioService, BrandAssetService, TemplateValidator],
})
export class TemplateStudioModule {}
