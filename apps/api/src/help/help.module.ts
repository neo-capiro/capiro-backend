import { Module } from '@nestjs/common';
import { HelpController } from './help.controller.js';
import { HelpService } from './help.service.js';
import {
  AdminSupportRequestsController,
  MySupportRequestsController,
} from './support-requests/support-requests.controller.js';
import { SupportRequestsService } from './support-requests/support-requests.service.js';

@Module({
  controllers: [HelpController, AdminSupportRequestsController, MySupportRequestsController],
  providers: [HelpService, SupportRequestsService],
})
export class HelpModule {}
