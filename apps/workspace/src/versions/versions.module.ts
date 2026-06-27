import { Module } from '@nestjs/common';
import { VersionsController } from './versions.controller.js';
import { VersionsService } from './versions.service.js';

@Module({
  controllers: [VersionsController],
  providers: [VersionsService],
  exports: [VersionsService],
})
export class VersionsModule {}
