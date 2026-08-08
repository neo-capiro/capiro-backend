import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { MicrosoftCallbacksController } from '../engagement/microsoft/microsoft-callbacks.controller.js';
import { GoogleCallbacksController } from '../engagement/google/google-callbacks.controller.js';

/** Unauthenticated provider callbacks and notifications, owner-policy guarded. */
@Module({
  imports: [EngagementModule],
  controllers: [MicrosoftCallbacksController, GoogleCallbacksController],
})
export class EngagementCallbacksModule {}
