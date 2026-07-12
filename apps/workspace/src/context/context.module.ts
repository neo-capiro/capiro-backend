import { Module } from '@nestjs/common';
import { DraftContextController } from './context.controller.js';
import { ContextService } from './context.service.js';

@Module({
  controllers: [DraftContextController],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
