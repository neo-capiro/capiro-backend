import { Module } from '@nestjs/common';
import { ObjectiveOperationalController } from './objective-operational.controller.js';
import { ObjectiveOperationalService } from './objective-operational.service.js';
import { ObjectiveOperationalGuard } from './objective-operational.guard.js';

/** Independent assembly: never imports Outreach or Engagement module graphs. */
@Module({
  controllers: [ObjectiveOperationalController],
  providers: [ObjectiveOperationalService, ObjectiveOperationalGuard],
})
export class ObjectiveOperationalModule {}
