import { Module } from '@nestjs/common';
import { XFeedController } from './x-feed.controller.js';
import { XFeedService } from './x-feed.service.js';

@Module({
  controllers: [XFeedController],
  providers: [XFeedService],
  exports: [XFeedService],
})
export class XFeedModule {}
