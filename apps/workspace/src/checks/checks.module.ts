import { Module } from '@nestjs/common';
import { ChecksController } from './checks.controller.js';
import { ChecksService } from './checks.service.js';

@Module({
  controllers: [ChecksController],
  providers: [ChecksService],
  exports: [ChecksService],
})
export class ChecksModule {}
