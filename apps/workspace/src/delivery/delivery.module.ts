import { Module } from '@nestjs/common';
import { DeliveryController, PublicShareController } from './delivery.controller.js';
import { DeliveryService } from './delivery.service.js';
import { ApprovalService } from './approval.service.js';
import { ShareLinkService } from './share-link.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [DeliveryController, PublicShareController],
  providers: [DeliveryService, ApprovalService, ShareLinkService],
  exports: [DeliveryService, ApprovalService, ShareLinkService],
})
export class DeliveryModule {}
