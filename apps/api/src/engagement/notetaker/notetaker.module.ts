import { Module } from '@nestjs/common';
import { MEETING_BOT_PROVIDER } from './meeting-bot.provider.js';
import { RecallProvider } from './recall.provider.js';

export const RAW_MEETING_BOT_PROVIDER = Symbol('RAW_MEETING_BOT_PROVIDER');

/**
 * Meeting Notetaker feature module — docs/plans/meeting-notetaker-bot-plan.md.
 *
 * The raw Recall implementation is exported under an internal token so
 * EngagementModule can replace the public MEETING_BOT_PROVIDER token with a
 * runtime-guarded proxy in the shadow service. Consumers that import only this
 * module (the existing main-only webhook path) retain the same provider behavior.
 */
@Module({
  providers: [
    { provide: RAW_MEETING_BOT_PROVIDER, useClass: RecallProvider },
    { provide: MEETING_BOT_PROVIDER, useExisting: RAW_MEETING_BOT_PROVIDER },
  ],
  exports: [MEETING_BOT_PROVIDER, RAW_MEETING_BOT_PROVIDER],
})
export class NotetakerModule {}
