import { Module } from '@nestjs/common';
import { CapabilitiesModule } from '../../capabilities/capabilities.module.js';
import { OutreachV3StateModule } from '../api/outreach-v3-state.module.js';
import { OutreachTargetCoverageService } from './outreach-target-coverage.service.js';
import { OutreachV3TargetsController } from './outreach-v3-targets.controller.js';
import { OutreachV3TargetsGuard } from './outreach-v3-targets.guard.js';
import { OutreachV3TargetsService } from './outreach-v3-targets.service.js';

@Module({
  imports: [CapabilitiesModule, OutreachV3StateModule],
  controllers: [OutreachV3TargetsController],
  providers: [OutreachTargetCoverageService, OutreachV3TargetsGuard, OutreachV3TargetsService],
  exports: [OutreachTargetCoverageService, OutreachV3TargetsService],
})
export class OutreachV3TargetsModule {}
