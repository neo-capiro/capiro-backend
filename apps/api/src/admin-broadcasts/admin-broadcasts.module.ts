import { Module } from '@nestjs/common';
import { AdminBroadcastsController } from './admin-broadcasts.controller.js';
import { AdminBroadcastsService } from './admin-broadcasts.service.js';
import { MeBroadcastsController } from './me-broadcasts.controller.js';

@Module({
  controllers: [AdminBroadcastsController, MeBroadcastsController],
  providers: [AdminBroadcastsService],
  exports: [AdminBroadcastsService],
})
export class AdminBroadcastsModule {}
