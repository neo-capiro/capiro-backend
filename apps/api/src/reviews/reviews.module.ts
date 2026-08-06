import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { MemoryReviewCompatibilityGuardService } from './memory-review-compatibility-guard.service.js';
import { ReviewsService } from './reviews.service.js';
import { ReviewsController } from './reviews.controller.js';

/**
 * Named-reviewer routing for held deliverables. Governed-memory rows are
 * explicitly excluded and must use MemoryModule's stricter review workflow.
 */
@Module({
  imports: [PrismaModule, EngagementModule],
  controllers: [ReviewsController],
  providers: [ReviewsService, MemoryReviewCompatibilityGuardService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
