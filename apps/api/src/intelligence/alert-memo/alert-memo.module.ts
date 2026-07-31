import { Module } from '@nestjs/common';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { ContextModule } from '../../context/context.module.js';
import { ContextCompilerService } from '../../context/context-compiler.service.js';
import { ReviewsModule } from '../../reviews/reviews.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AlertMemoController } from './alert-memo.controller.js';
import { AlertMemoService } from './alert-memo.service.js';
import {
  createGovernedAlertMemoService,
  RAW_ALERT_MEMO_SERVICE,
} from './governed-alert-deliverables.factory.js';
import { HearingRecapController } from './hearing-recap.controller.js';
import { HearingRecapService } from './hearing-recap.service.js';

/**
 * Alert → client-memo generation. Standalone module so it can pull exactly what
 * the memo needs without widening the intelligence module's dependency graph:
 *   - EngagementModule → EngagementService (Documents auto-file) + AiCredentialResolverService (per-tenant key)
 *   - ContextModule -> ContextCompilerService (client Memory files as steering, G1)
 *   - PrismaModule → recordAiUsageEvent metering (Phase 1 M5.0, H-1)
 * The docx is rendered by the module-local `renderMemoDocx` (a dedicated memo
 * template), so no doc-gen service dependency is needed.
 *
 * The hearing recap lives here for exactly one reason: it files the SAME memo
 * DOCX through the SAME Documents/Engagement boundary. It is deliberately a
 * separate controller + service, not an alert-memo variant — a recap has no
 * alertId and none of the alert-memo governance (held-gate, entailment review),
 * so reusing that endpoint made every save fail the global ValidationPipe.
 */
@Module({
  imports: [EngagementModule, ContextModule, PrismaModule, ReviewsModule],
  controllers: [AlertMemoController, HearingRecapController],
  providers: [
    { provide: RAW_ALERT_MEMO_SERVICE, useClass: AlertMemoService },
    {
      provide: AlertMemoService,
      useFactory: createGovernedAlertMemoService,
      inject: [RAW_ALERT_MEMO_SERVICE, ContextCompilerService],
    },
    HearingRecapService,
  ],
})
export class AlertMemoModule {}
