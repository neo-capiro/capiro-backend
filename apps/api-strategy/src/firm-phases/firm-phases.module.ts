import { Module } from '@nestjs/common';
import { FirmPhasesController } from './firm-phases.controller.js';
import { FirmPhasesService } from './firm-phases.service.js';

@Module({
  controllers: [FirmPhasesController],
  providers: [FirmPhasesService],
  exports: [FirmPhasesService],
})
export class FirmPhasesModule {}
