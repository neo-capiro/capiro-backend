import { Module } from '@nestjs/common';
import { DeliveryController, PublicShareController, SharesController } from './delivery.controller.js';
import { ShareLinkService } from './share-link.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [DeliveryController, PublicShareController, SharesController],
  providers: [ShareLinkService],
  exports: [ShareLinkService],
})
export class DeliveryModule {}
