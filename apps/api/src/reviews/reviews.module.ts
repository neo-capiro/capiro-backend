import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ClientDocumentsModule } from '../client-documents/client-documents.module.js';
import { OutreachReviewModule } from '../outreach-review/outreach-review.module.js';
import { MemoryReviewCompatibilityGuardService } from './memory-review-compatibility-guard.service.js';
import { ReviewsService } from './reviews.service.js';
import { ReviewsController } from './reviews.controller.js';

/**
 * Named-reviewer routing for held deliverables. Governed-memory rows are
 * explicitly excluded and must use MemoryModule's stricter review workflow.
 */
@Module({
  imports: [PrismaModule, ClientDocumentsModule, OutreachReviewModule],
  controllers: [ReviewsController],
  providers: [ReviewsService, MemoryReviewCompatibilityGuardService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
