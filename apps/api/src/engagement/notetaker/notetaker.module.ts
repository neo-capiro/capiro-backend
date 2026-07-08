import { Module } from '@nestjs/common';
import { MEETING_BOT_PROVIDER } from './meeting-bot.provider.js';
import { RecallProvider } from './recall.provider.js';

/**
 * Meeting Notetaker feature module — docs/plans/meeting-notetaker-bot-plan.md.
 *
 * Phase 0: binds the {@link MeetingBotProvider} DI token to the Recall.ai
 * implementation and exports it for the Phase-1 consumers (the dispatch service +
 * the /webhooks/recall receiver). ConfigModule is global (app.module), so
 * RecallProvider resolves ConfigService without an explicit import here.
 */
@Module({
  providers: [{ provide: MEETING_BOT_PROVIDER, useClass: RecallProvider }],
  exports: [MEETING_BOT_PROVIDER],
})
export class NotetakerModule {}
