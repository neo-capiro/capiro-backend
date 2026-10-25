import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { BusinessDevelopmentFlagGuard } from '../business-development-flag.guard.js';
import { ProspectContactsController } from './prospect-contacts.controller.js';
import { ProspectContactsService } from './prospect-contacts.service.js';
import { EmbeddingsModule } from '../../embeddings/embeddings.module.js';
import { ProspectContactTransfersService } from './prospect-contact-transfers.service.js';

@Module({
  imports: [PrismaModule, EmbeddingsModule],
  controllers: [ProspectContactsController],
  providers: [
    ProspectContactsService,
    ProspectContactTransfersService,
    BusinessDevelopmentFlagGuard,
  ],
  exports: [ProspectContactsService],
})
export class ProspectContactsModule {}
