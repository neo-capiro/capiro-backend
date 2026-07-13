import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { ReviewsService } from './reviews.service.js';
import { ReviewsController } from './reviews.controller.js';

/**
 * G4 named-reviewer routing. EngagementModule supplies the Documents
 * auto-file (releasing a held memo = the file the hold skipped). Exported so
 * the hold sites (AlertMemoModule, MeriModule/research) emit review requests.
 */
@Module({
  imports: [PrismaModule, EngagementModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
