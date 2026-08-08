import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OutreachTruthService } from '../engagement/generation/outreach-truth.service.js';

/**
 * Neutral composition boundary for canonical bill, state-bill, and PE truth.
 * The implementation remains singular; Engagement and deliverables consume it.
 */
@Module({
  imports: [PrismaModule],
  providers: [OutreachTruthService],
  exports: [OutreachTruthService],
})
export class CapiroTruthModule {}
