import { Module } from '@nestjs/common';
import { HillDaySourceService } from '../hillday/hillday-source.service.js';
import { AiCredentialService } from '../generation/ai-credential.service.js';
import { NewsletterService } from './newsletter.service.js';
import { NewsletterImageService } from './newsletter-image.service.js';
import { NewsletterHtmlCheckService } from './newsletter-html-check.service.js';
import { NewsletterAssetImportService } from './newsletter-asset-import.service.js';
import { NewsletterStockImageService } from './newsletter-stock-image.service.js';
import { NewsletterLinkPreviewService } from './newsletter-link-preview.service.js';
import { NewsletterVideoService } from './newsletter-video.service.js';
import { NewsletterStockImageController } from './newsletter-stock-image.controller.js';
import { NewsletterController, NewsletterAssetController } from './newsletter.controller.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
@Module({
  imports: [NotificationsModule],
  controllers: [NewsletterController, NewsletterAssetController, NewsletterStockImageController],
  providers: [
    NewsletterService,
    NewsletterImageService,
    NewsletterHtmlCheckService,
    NewsletterAssetImportService,
    NewsletterStockImageService,
    NewsletterLinkPreviewService,
    NewsletterVideoService,
    HillDaySourceService,
    AiCredentialService,
  ],
})
export class NewsletterModule {}
