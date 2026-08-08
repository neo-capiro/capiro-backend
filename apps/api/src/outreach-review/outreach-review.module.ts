import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { OutreachReviewTransactionsService } from './outreach-review-transactions.service.js';

@Module({
  imports: [PrismaModule, EngagementModule],
  providers: [OutreachReviewTransactionsService],
  exports: [OutreachReviewTransactionsService],
})
export class OutreachReviewModule {}
