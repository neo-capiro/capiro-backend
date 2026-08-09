import { Module } from '@nestjs/common';
import { CapabilitiesModule } from '../../capabilities/capabilities.module.js';
import { OutreachV3StateModule } from '../api/outreach-v3-state.module.js';
import { OutreachV3ContextController } from './outreach-v3-context.controller.js';
import { OutreachV3ContextGuard } from './outreach-v3-context.guard.js';
import { OutreachV3ContextService } from './outreach-v3-context.service.js';

@Module({
  imports: [CapabilitiesModule, OutreachV3StateModule],
  controllers: [OutreachV3ContextController],
  providers: [OutreachV3ContextGuard, OutreachV3ContextService],
  exports: [OutreachV3ContextService],
})
export class OutreachV3ContextModule {}
